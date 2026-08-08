const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createEmotionService } = require('../src/core/emotion-state');

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-emotion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    service: createEmotionService(path.join(directory, 'emotion.json')),
  };
}

test('Given repeated praise When affection is recorded many times in one day Then gains are capped so farming never inflates affection', (t) => {
  const { service } = createFixture(t);
  for (let i = 0; i < 30; i += 1) {
    service.recordEvent('USER_PRAISE', { affection: 2, moodScore: 4 });
  }
  const state = service.getState();
  assert.equal(state.affection, 50);
  assert.ok(state.affection <= 50);
});

test('Given continuous negative feedback When affection loses are recorded Then losses honor the daily lower bound', (t) => {
  const { service } = createFixture(t);
  for (let i = 0; i < 20; i += 1) {
    service.recordEvent('USER_NEGATIVE', { affection: -1, stress: 2 });
  }
  const state = service.getState();
  assert.ok(state.affection >= 10);
});

test('Given emotion events When queried by type Then a bounded chronological history is returned', (t) => {
  const { service } = createFixture(t);
  service.recordEvent('APP_STARTED', {});
  service.recordEvent('USER_GREETING', { moodScore: 3, affection: 1 });
  service.recordEvent('USER_PRAISE', { moodScore: 4, affection: 2 });

  const praise = service.getEvents({ type: 'USER_PRAISE' });
  assert.equal(praise.length, 1);
  assert.equal(praise[0].type, 'USER_PRAISE');
  assert.equal(praise[0].source, 'conversation');
  assert.ok(praise[0].deltas && praise[0].deltas.affection === 2);

  const all = service.getEvents();
  assert.equal(all.length, 3);
  assert.equal(all[2].type, 'USER_PRAISE');
});

test('Given emotion state When persisted to disk Then events survive a restart and remain queryable', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-emotion-restart-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'emotion.json');

  const first = createEmotionService(filePath);
  first.recordEvent('USER_THANKS', { affection: 1 });

  const restarted = createEmotionService(filePath);
  assert.equal(restarted.getEvents({ type: 'USER_THANKS' }).length, 1);
  assert.equal(restarted.getEvents({ type: 'USER_THANKS' })[0].deltas.affection, 1);
});