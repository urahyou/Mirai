const assert = require('node:assert/strict');
const test = require('node:test');
const createMemoryVectorIndexer = require('../src/services/memory-vector-indexer');

function episode(id, summary, extra = {}) {
  return { id, summary, startedAt: '2026-08-18T08:00:00Z', recallState: 'active', ...extra };
}

test('memory vector indexer stays inert when embedding is disabled', async () => {
  let listed = 0;
  const indexer = createMemoryVectorIndexer({
    memory: { listVectorPending: async () => { listed += 1; return []; }, upsertVector: async () => null },
    embedding: { getStatus: () => ({ ready: false, model: '' }), embed: async () => { throw new Error('must not embed'); } },
  });
  assert.deepEqual(await indexer.syncPending(), { indexed: 0, skipped: 0 });
  assert.deepEqual(await indexer.enqueue([episode('episode:1', '不会索引')]), { indexed: 0, skipped: 0 });
  assert.equal(listed, 0);
});

test('memory vector indexer batches unique active episodes and writes caller-produced vectors', async () => {
  const embedded = [];
  const stored = [];
  const embedding = {
    getStatus: () => ({ ready: true, model: 'local-embed' }),
    embed: async (texts) => {
      embedded.push(texts);
      return { model: 'local-embed', dimensions: 2, vectors: texts.map((_, index) => [1, index + 1]) };
    },
  };
  const memory = {
    listVectorPending: async (model, limit) => {
      assert.equal(model, 'local-embed');
      assert.equal(limit, 50);
      return [episode('episode:1', '第一段'), episode('episode:2', '第二段')];
    },
    upsertVector: async (item) => { stored.push(item); return { id: `vector:${item.chunkId}` }; },
  };
  const indexer = createMemoryVectorIndexer({ memory, embedding, batchSize: 2 });
  assert.deepEqual(await indexer.syncPending(), { indexed: 2, skipped: 0 });
  assert.deepEqual(embedded, [['第一段', '第二段']]);
  assert.equal(stored[0].chunkId, 'episode:1');
  assert.deepEqual(stored[0].sourceIds, ['episode:1']);
  assert.deepEqual(stored[1].vector, [1, 2]);

  const result = await indexer.enqueue([
    episode('episode:3', '第三段'), episode('episode:3', '重复'),
    episode('episode:4', '已淡忘', { recallState: 'faded' }),
  ]);
  assert.deepEqual(result, { indexed: 1, skipped: 0 });
  assert.deepEqual(embedded[1], ['第三段']);
});

test('memory vector index queue continues after one failed job', async () => {
  let attempts = 0;
  const warnings = [];
  const indexer = createMemoryVectorIndexer({
    memory: { upsertVector: async () => ({ id: 'vector:ok' }), listVectorPending: async () => [] },
    embedding: {
      getStatus: () => ({ ready: true, model: 'local-embed' }),
      embed: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
        return { model: 'local-embed', dimensions: 1, vectors: [[1]] };
      },
    },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  await assert.rejects(indexer.enqueue([episode('episode:1', '失败')]), /temporary failure/);
  assert.deepEqual(await indexer.enqueue([episode('episode:2', '恢复')]), { indexed: 1, skipped: 0 });
  assert.match(warnings[0], /temporary failure/);
});
