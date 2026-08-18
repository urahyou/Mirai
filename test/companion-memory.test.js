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
  assert.equal(await memory.createEpisode({ summary: '测试' }), false);
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

test('Companion memory archives pending canonical messages through Python Core', async () => {
  const calls = [];
  const memory = createCompanionMemory({
    pythonBackend: {
      getStatus: () => ({ ready: true }),
      request: async (method, params) => {
        calls.push([method, params]);
        return { archived: [{ id: 'episode:1', summary: '一次相处' }], count: 1 };
      },
    },
  });
  const result = await memory.archivePending({ currentAt: '2026-08-18T12:00:00Z', force: true });
  assert.equal(result[0].id, 'episode:1');
  assert.deepEqual(calls, [['memory.archive_pending', { currentAt: '2026-08-18T12:00:00Z', force: true }]]);
});

test('Companion memory exposes candidate review and non-destructive forgetting', async () => {
  const calls = [];
  const memory = createCompanionMemory({
    pythonBackend: {
      getStatus: () => ({ ready: true }),
      request: async (method, params) => {
        calls.push([method, params]);
        if (method === 'memory.list_candidates') return { candidates: [{ id: 'candidate:1', status: 'pending' }] };
        if (method === 'memory.review_candidate') return { candidate: { id: params.candidateId, status: params.decision } };
        if (method === 'memory.forget_source') return { changed: 1 };
        return {};
      },
    },
  });
  assert.equal((await memory.listCandidates({ status: 'pending' }))[0].status, 'pending');
  assert.equal((await memory.reviewCandidate('candidate:1', 'rejected')).status, 'rejected');
  assert.equal(await memory.forgetSource('episode:1'), 1);
  assert.deepEqual(calls, [
    ['memory.list_candidates', { limit: 30, status: 'pending' }],
    ['memory.review_candidate', { candidateId: 'candidate:1', decision: 'rejected', supersedesId: undefined }],
    ['memory.forget_source', { sourceId: 'episode:1', toState: 'faded', reason: 'user-request' }],
  ]);
});
