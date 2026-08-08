const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProactivePolicy } = require('../src/services/proactive-policy');
const { createProactiveSettingsStore } = require('../src/services/proactive-settings-store');

function createStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-proactive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return createProactiveSettingsStore({ filePath: path.join(directory, 'proactive-settings.json') });
}

function policyFor(store) {
  return createProactivePolicy({ getSettings: () => store.get() });
}

function mondayAt(hour, minute) {
  return new Date(2026, 0, 5, hour, minute, 0, 0);
}

test('Given the existing idle renderer When it schedules proactive checks Then the 20-60 second cadence remains intact', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

  assert.match(renderer, /const delay = 20000 \+ Math\.random\(\) \* 40000/);
  assert.match(renderer, /idleTimer = setTimeout\(async \(\) => \{/);
  assert.match(renderer, /await window\.desktopPet\.requestProactiveDecision\(\);/);
  assert.match(renderer, /window\.desktopPet\.onProactiveDecision\(\(decision\) => \{/);
  assert.match(renderer, /if \(decision\.shouldPrompt\) showBalloon\(decision\.content, 'idle'\);/);
});

test('Given no saved consent When proactive settings load Then proactive prompting defaults to disabled', (t) => {
  const store = createStore(t);

  assert.equal(store.get().enabled, false);
  assert.deepEqual(policyFor(store).decide({ now: mondayAt(12, 0), content: '你好' }), {
    shouldPrompt: false,
    reason: 'disabled',
  });
});

test('Given enabled proactive settings When quiet hours apply Then the policy suppresses with an explainable reason', (t) => {
  const store = createStore(t);
  store.set({ enabled: true, quietHours: { allow: [[0, 7 * 60]] } });

  assert.deepEqual(policyFor(store).decide({ now: mondayAt(22, 30), content: '晚安' }), {
    shouldPrompt: false,
    reason: 'quiet-hours',
  });
});

test('Given enabled proactive settings When paused Then the policy suppresses with an explainable reason', (t) => {
  const store = createStore(t);
  store.set({ enabled: true, pausedUntil: mondayAt(13, 0).toISOString() });

  assert.deepEqual(policyFor(store).decide({ now: mondayAt(12, 0), content: '你好' }), {
    shouldPrompt: false,
    reason: 'paused',
  });
});

test('Given enabled proactive settings When a period budget is exhausted Then the policy suppresses', (t) => {
  const store = createStore(t);
  const now = mondayAt(12, 50);
  store.set({ enabled: true, hourlyBudget: 1, dailyBudget: 3, cooldownMinutes: 0 });

  assert.deepEqual(policyFor(store).decide({
    now,
    content: '你好',
    promptHistory: [{ at: mondayAt(12, 30).toISOString(), content: '之前的问候' }],
  }), {
    shouldPrompt: false,
    reason: 'hourly-budget',
  });
});

test('Given enabled proactive settings When the daily budget is exhausted Then the policy suppresses', (t) => {
  const store = createStore(t);
  const now = mondayAt(12, 0);
  store.set({ enabled: true, hourlyBudget: 3, dailyBudget: 1, cooldownMinutes: 0 });

  assert.deepEqual(policyFor(store).decide({
    now,
    content: '你好',
    promptHistory: [{ at: mondayAt(8, 0).toISOString(), content: '之前的问候' }],
  }), {
    shouldPrompt: false,
    reason: 'daily-budget',
  });
});

test('Given enabled proactive settings When the cooldown is active Then the policy suppresses', (t) => {
  const store = createStore(t);
  const now = mondayAt(12, 0);
  store.set({ enabled: true, cooldownMinutes: 15, hourlyBudget: 3, dailyBudget: 5 });

  assert.deepEqual(policyFor(store).decide({
    now,
    content: '你好',
    promptHistory: [{ at: mondayAt(11, 50).toISOString(), content: '之前的问候' }],
  }), {
    shouldPrompt: false,
    reason: 'cooldown',
  });
});

test('Given enabled proactive settings When content repeats Then the policy suppresses', (t) => {
  const store = createStore(t);
  const now = mondayAt(12, 0);
  store.set({ enabled: true, cooldownMinutes: 0, hourlyBudget: 3, dailyBudget: 5 });

  assert.deepEqual(policyFor(store).decide({
    now,
    content: '今天过得怎么样？',
    promptHistory: [{ at: mondayAt(9, 0).toISOString(), content: '今天过得怎么样？' }],
  }), {
    shouldPrompt: false,
    reason: 'repeated-content',
  });
});

test('Given enabled proactive settings When both budgets have room Then the policy speaks', (t) => {
  const store = createStore(t);
  const now = mondayAt(12, 0);
  store.set({ enabled: true, hourlyBudget: 2, dailyBudget: 3, cooldownMinutes: 0 });

  assert.deepEqual(policyFor(store).decide({
    now,
    content: '休息一下吧',
    promptHistory: [
      { at: mondayAt(11, 0).toISOString(), content: '喝点水吧' },
      { at: mondayAt(8, 0).toISOString(), content: '早上好' },
    ],
  }), {
    shouldPrompt: true,
    reason: 'eligible',
  });
});

test('Given saved proactive settings When the store restarts Then consent settings are preserved', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-proactive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proactive-settings.json');
  const expected = {
    enabled: true,
    pausedUntil: null,
    quietHours: { allow: [[60, 120]], weekdays: [1, 2, 3, 4, 5] },
    hourlyBudget: 2,
    dailyBudget: 7,
    cooldownMinutes: 30,
  };

  createProactiveSettingsStore({ filePath }).set(expected);

  assert.deepEqual(createProactiveSettingsStore({ filePath }).get(), expected);
});

test('Given corrupt or erased proactive settings When the store loads Then it safely recovers defaults and removes all settings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-proactive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'proactive-settings.json');
  fs.writeFileSync(filePath, '{invalid', 'utf8');
  const store = createProactiveSettingsStore({ filePath });

  assert.equal(store.get().enabled, false);
  assert.ok(fs.readdirSync(directory).some((entry) => entry.startsWith('proactive-settings.json.corrupt-')));
  store.eraseAll();
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('Given twenty non-responses When proactive policy evaluates each opportunity Then consent and service quality remain unchanged', (t) => {
  const store = createStore(t);
  const before = store.set({ enabled: true, hourlyBudget: 24, dailyBudget: 24, cooldownMinutes: 0 });
  const policy = policyFor(store);
  const decisions = Array.from({ length: 20 }, (_, index) => policy.decide({
    now: mondayAt(12, index),
    content: `友好提示 ${index}`,
    nonResponseCount: index + 1,
  }));

  assert.deepEqual(store.get(), before);
  assert.deepEqual(decisions, Array.from({ length: 20 }, () => ({ shouldPrompt: true, reason: 'eligible' })));
  for (const decision of decisions) {
    assert.equal(decision.shouldPrompt, true);
    assert.doesNotMatch(decision.reason, /guilt|jealous|suffer|punish|non-?response/i);
  }
});
