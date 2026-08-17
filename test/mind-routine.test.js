const assert = require('node:assert/strict');
const test = require('node:test');
const { createEventBus } = require('../src/services/event-bus');
const E = require('../src/contracts/events');
const mind = require('../src/systems/mind-routine');

test('mind routine records activity thoughts with bounded lifetime and source', async () => {
  const saved = [];
  const bus = createEventBus();
  mind.init({ eventBus: bus, companionMemory: { recordThought: async (row) => { saved.push(row); return row; }, listMind: async () => [] } });
  bus.emit(E.LIFE.ACTIVITY_COMPLETED, { activityId: 'school', completedAt: 1_786_968_800_000, state: { recentActivities: [{ id: 'activity:school:1' }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.match(saved[0].content, /上学/);
  assert.deepEqual(saved[0].sourceIds, ['activity:school:1']);
  assert.ok(saved[0].expiresAt);
  mind.stop();
});

test('mind routine makes one nightly reflection or fictional dream per day', async () => {
  const calls = [];
  const memory = { listMind: async () => [], recordThought: async () => null, recordReflection: async (row) => { calls.push(['reflection', row]); }, recordDream: async (row) => { calls.push(['dream', row]); } };
  mind.init({ eventBus: createEventBus(), companionMemory: memory });
  const day = new Date(2026, 7, 18, 22, 0, 0).valueOf();
  await mind.nightly(day);
  await mind.nightly(new Date(2026, 7, 18, 23, 0, 0).valueOf());
  assert.equal(calls[0][0], 'reflection');
  assert.equal(calls[1][0], 'dream');
  assert.match(calls[1][1].content, /梦/);
  mind.stop();
});
