const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const createPetStateAdapter = require('../src/services/pet-state-adapter');

test('pet state adapter serializes Python mutations and emits settled state in order', async () => {
  const requests = [];
  let call = 0;
  const backend = {
    getStatus: () => ({ ready: true }),
    request: async (_method, { eventType }) => {
      requests.push(eventType);
      const current = ++call;
      // The first call is intentionally slower: a concurrent implementation would expose stale state.
      await new Promise((resolve) => setTimeout(resolve, current === 1 ? 20 : 0));
      return { state: { emotion: { moodScore: current }, affection: {}, nurture: {} } };
    },
  };
  const fallback = { getState: () => ({ emotion: { moodScore: 0 }, affection: {}, nurture: {} }), applyEvent: () => assert.fail('fallback should not run') };
  const bus = new EventEmitter();
  const settled = [];
  bus.on('one', ({ emotion }) => settled.push(emotion.moodScore));
  bus.on('two', ({ emotion }) => settled.push(emotion.moodScore));
  const adapter = createPetStateAdapter({ pythonBackend: backend, fallback });
  adapter.init({ eventBus: bus });
  adapter.applyEvent('one');
  adapter.applyEvent('two');
  await adapter.whenIdle();
  assert.deepEqual(requests, ['one', 'two']);
  assert.deepEqual(settled, [1, 2]);
  assert.equal(adapter.getState().emotion.moodScore, 2);
});
