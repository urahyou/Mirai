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
  assert.deepEqual(await memory.retrieve('旧服务不能回退'), {
    query: '旧服务不能回退', capacity: 8, items: [], channels: { keyword: 0, graph: 0, vector: 0 },
  });
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

test('Companion memory only exposes a graph returned by the Python Core', async () => {
  const memory = createCompanionMemory({
    pythonBackend: {
      getStatus: () => ({ ready: true }),
      request: async (method, params) => {
        assert.equal(method, 'memory.graph');
        assert.equal(params.limit, 50);
        return { nodes: [{ id: 'character:mirai' }], edges: [{ id: 'edge:1' }] };
      },
    },
  });
  assert.deepEqual(await memory.getGraph(), { nodes: [{ id: 'character:mirai' }], edges: [{ id: 'edge:1' }] });
});

test('Companion memory retrieves a bounded frame and renders safe context', async () => {
  const memory = createCompanionMemory({
    pythonBackend: {
      getStatus: () => ({ ready: true }),
      request: async (method, params) => {
        assert.equal(method, 'memory.retrieve');
        assert.equal(params.query, '草莓蛋糕');
        assert.equal(params.limit, 2);
        assert.match(params.currentAt, /^\d{4}-\d{2}-\d{2}T/);
        return {
          query: params.query,
          capacity: 2,
          items: [
            { id: 'fact:1', kind: 'fact', content: 'owner:default likes 草莓蛋糕', score: 0.9 },
            { id: 'edge:1', kind: 'edge', content: 'owner:default visits place:bakery', score: 0.4 },
          ],
          channels: { keyword: 1, graph: 1, vector: 0 },
        };
      },
    },
  });
  const frame = await memory.retrieve('草莓蛋糕', 2);
  assert.equal(frame.items.length, 2);
  assert.deepEqual(frame.channels, { keyword: 1, graph: 1, vector: 0 });
  const context = memory.formatContext(frame);
  assert.match(context, /\[当前事实\].*草莓蛋糕/);
  assert.match(context, /\[当前关系\].*place:bakery/);
  assert.doesNotMatch(context, /undefined/);
  const oversized = memory.formatContext({
    items: Array.from({ length: 10 }, (_, index) => ({ kind: 'episode', content: `${index}:${'很长的记忆'.repeat(300)}` })),
  });
  assert.ok(oversized.length <= 4400);
  assert.equal((oversized.match(/\[相处片段\]/g) || []).length, 6);
});
