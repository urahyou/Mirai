const assert = require('node:assert/strict');
const test = require('node:test');
const createCompanionMemory = require('../src/services/companion-memory');

test('Companion Core is the only memory backend when unavailable', async () => {
  const memory = createCompanionMemory({
    pythonBackend: {
      getStatus: () => ({ ready: false }),
      request: () => { throw new Error('must not request while unavailable'); },
    },
  });
  assert.deepEqual(await memory.search('旧服务不能回退'), []);
  assert.equal(await memory.add([{ role: 'user', content: '测试' }], '2026-08-17T00:00:00Z'), false);
  assert.equal((await memory.getStatus()).backend, 'python-core');
});

test('Companion memory reports SQLite stats from Python Core', async () => {
  const memory = createCompanionMemory({
    pythonBackend: {
      getStatus: () => ({ ready: true }),
      request: async (method) => {
        assert.equal(method, 'memory.stats');
        return { episodes: 2, facts: 1, profiles: 1, edges: 3, events: 4, dailyJournals: 1, weeklyJournals: 0 };
      },
    },
  });
  const status = await memory.getStatus();
  assert.deepEqual(status, { ok: true, state: 'ready', backend: 'python-core', storage: 'SQLite', vectorSearch: false, graphSearch: true, episodes: 2, facts: 1, profiles: 1, edges: 3, events: 4, dailyJournals: 1, weeklyJournals: 0 });
});
