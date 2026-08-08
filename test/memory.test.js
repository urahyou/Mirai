const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMemoryService } = require('../src/services/memory-service');
const { createMemoryStore } = require('../src/services/memory-store');

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    service: createMemoryService(createMemoryStore({ filePath: path.join(directory, 'memory.json') })),
  };
}

test('Given sensitive, inferred, low-confidence, and declined input When memory is requested Then none persists, retrieves, logs, or enters prompt context', (t) => {
  const { directory, service } = createFixture(t);
  const logLines = [];
  const originalLog = console.log;
  console.log = (...values) => logLines.push(values.join(' '));
  t.after(() => { console.log = originalLog; });

  // Given untrusted candidates that must never cross the persistence or provider boundary.
  const apiKey = 'sk-test-private-api-key';
  const healthInference = 'I infer that you have a serious health condition';

  // When the service is asked to remember each candidate or is explicitly declined.
  assert.equal(service.remember({ type: 'preference', content: apiKey, explicit: true }), null);
  assert.equal(service.remember({ type: 'profile', content: healthInference, explicit: true }), null);
  assert.equal(service.remember({ type: 'work', content: 'Maybe the user likes espresso', confidence: 0.2, importance: 0.2 }), null);
  assert.equal(service.remember({ type: 'unknown', content: 'User prefers tea', explicit: true }), null);
  assert.equal(service.remember({ type: 'preference', content: 'User prefers tea', source: apiKey, explicit: true }), null);
  assert.equal(service.doNotRemember({ type: 'preference', content: 'User prefers tea' }), true);
  assert.equal(service.remember({ type: 'preference', content: 'User prefers tea', explicit: true }), null);

  // Then the sensitive values never reach durable data, retrieval, logs, or an outbound prompt context.
  assert.deepEqual(service.list(), []);
  assert.deepEqual(service.retrieve({ query: 'tea' }), []);
  assert.deepEqual(service.getPromptMemories({ query: 'tea', networkAllowed: true }), []);
  const storedBytes = fs.readFileSync(path.join(directory, 'memory.json'), 'utf8');
  assert.equal(storedBytes.includes(apiKey), false);
  assert.equal(storedBytes.includes(healthInference), false);
  assert.equal(storedBytes.includes('Maybe the user likes espresso'), false);
  assert.equal(storedBytes.includes('User prefers tea'), false);
  assert.equal(logLines.join('\n').includes(apiKey), false);
  assert.equal(logLines.join('\n').includes(healthInference), false);
});

test('Given explicit memories When create retrieve edit delete clear export and restart occur Then each observable operation is local and deterministic', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'memory.json');
  const service = createMemoryService(createMemoryStore({ filePath }), {
    clock: () => new Date('2026-08-07T10:00:00.000Z'),
    createId: (() => { let index = 0; return () => `memory-${++index}`; })(),
  });

  // Given explicit records across allowed categories.
  const profile = service.remember({ type: 'profile', content: 'User lives in Kyoto', explicit: true, importance: 0.8 });
  const preference = service.remember({ type: 'preference', content: 'User likes jasmine tea', explicit: true, importance: 0.9 });
  service.remember({ type: 'episodic', content: 'Discussed a Kyoto tea shop', explicit: true, importance: 0.9 });

  // When the user searches, edits, removes, exports, restarts, and clears their data.
  assert.deepEqual(service.retrieve({ query: 'tea', types: ['preference'] }).map((memory) => memory.id), [preference.id]);
  const edited = service.update(profile.id, { content: 'User lives in Osaka', importance: 1 });
  assert.equal(edited.content, 'User lives in Osaka');
  assert.equal(service.remove(preference.id), true);
  const exported = service.exportData();
  const restarted = createMemoryService(createMemoryStore({ filePath }));

  // Then all persisted data remains inspectable, deleted content is absent, export is schema-versioned, and clear removes personal data.
  assert.deepEqual(restarted.retrieve({ query: 'tea' }).map((memory) => memory.content), ['Discussed a Kyoto tea shop']);
  assert.equal(restarted.list().some((memory) => memory.id === preference.id), false);
  assert.deepEqual(exported.schemaVersion, 1);
  assert.equal(exported.data.memories.length, 2);
  restarted.clearAll();
  assert.equal(fs.existsSync(filePath), false);
});

test('Given expired and prompt-ineligible memories When archival and network-gated prompt selection run Then only allowed active entries fit the fixed budget', (t) => {
  let now = new Date('2026-08-07T10:00:00.000Z');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-clock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clocked = createMemoryService(createMemoryStore({ filePath: path.join(directory, 'memory.json') }), { clock: () => now });
  clocked.remember({ type: 'preference', content: 'User likes tea', explicit: true, importance: 1 });
  clocked.remember({ type: 'episodic', content: 'Tea chat happened', explicit: true, importance: 1 });
  clocked.remember({ type: 'work', content: 'Tea project plan', explicit: true, importance: 0.8, expiresAt: '2026-08-07T09:00:00.000Z' });

  // When expired entries are archived and a provider context is selected.
  const archived = clocked.archiveExpired();
  const offline = clocked.getPromptMemories({ query: 'tea', networkAllowed: false });
  const online = clocked.getPromptMemories({ query: 'tea', networkAllowed: true, maxChars: 20 });

  // Then archive removes expired entries, episodic data stays local, and the prompt cannot exceed its fixed cap.
  assert.equal(archived.length, 1);
  assert.deepEqual(offline, []);
  assert.deepEqual(online.map((memory) => memory.type), ['preference']);
  assert.ok(clocked.buildPromptContext({ query: 'tea', networkAllowed: true, maxChars: 20 }).length <= 20);
  now = new Date('2026-08-07T11:00:00.000Z');
});

test('Given equal-important explicit records When retrieval receives keyword and type filters Then results use a stable recency and id tie-break', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-order-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const times = [
    new Date('2026-08-07T10:00:00.000Z'),
    new Date('2026-08-07T11:00:00.000Z'),
    new Date('2026-08-07T12:00:00.000Z'),
  ];
  const service = createMemoryService(createMemoryStore({ filePath: path.join(directory, 'memory.json') }), {
    clock: () => times.shift() || new Date('2026-08-07T12:00:00.000Z'),
    createId: (() => { let index = 0; return () => `memory-${++index}`; })(),
  });

  // Given records with a shared keyword and importance but distinct type and access time.
  service.remember({ type: 'profile', content: 'Tea note first', explicit: true, importance: 0.8 });
  service.remember({ type: 'preference', content: 'Tea note second', explicit: true, importance: 0.8 });

  // When keyword and category filters select the eligible records.
  const result = service.retrieve({ query: 'tea note', types: ['profile', 'preference'] });

  // Then the newer record ranks before the older one with deterministic output.
  assert.deepEqual(result.map((memory) => memory.id), ['memory-2', 'memory-1']);
});
