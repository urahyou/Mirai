const assert = require('node:assert/strict');
const test = require('node:test');
const createEmbeddingAdapter = require('../src/services/embedding-adapter');

const validEnv = {
  MIRAI_EMBEDDING_ENABLED: 'true',
  MIRAI_EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1/',
  MIRAI_EMBEDDING_MODEL: 'nomic-embed-text',
  MIRAI_EMBEDDING_API_KEY: 'secret',
};

test('embedding adapter stays inert until explicitly enabled and fully configured', async () => {
  let calls = 0;
  const disabled = createEmbeddingAdapter({
    readEnv: () => ({ MIRAI_EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1', MIRAI_EMBEDDING_MODEL: 'embed' }),
    fetchImpl: async () => { calls += 1; },
  });
  assert.deepEqual(disabled.getStatus(), { enabled: false, ready: false, model: 'embed', endpoint: '' });
  await assert.rejects(disabled.embed('不会发送'), /未启用/);
  assert.equal(calls, 0);

  const incomplete = createEmbeddingAdapter({ readEnv: () => ({ MIRAI_EMBEDDING_ENABLED: 'true' }) });
  assert.equal(incomplete.getStatus().ready, false);
  await assert.rejects(incomplete.embed('不会发送'), /配置不完整/);
});

test('embedding adapter calls an OpenAI-compatible endpoint and restores response order', async () => {
  const calls = [];
  const adapter = createEmbeddingAdapter({
    readEnv: () => validEnv,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      }), { status: 200 });
    },
  });
  const result = await adapter.embed(['第一段', '第二段']);
  assert.equal(result.model, 'nomic-embed-text');
  assert.equal(result.dimensions, 3);
  assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
  assert.equal(calls[0][0], 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0][1].body), { model: 'nomic-embed-text', input: ['第一段', '第二段'] });
});

test('embedding adapter rejects malformed vectors, duplicate indices, and oversized batches', async () => {
  const adapter = createEmbeddingAdapter({
    readEnv: () => validEnv,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, Number.NaN] }] }), { status: 200 }),
  });
  await assert.rejects(adapter.embed('测试'), /向量不合法/);
  await assert.rejects(adapter.embed(Array.from({ length: 17 }, () => '测试')), /最多 16 条/);

  const duplicate = createEmbeddingAdapter({
    readEnv: () => validEnv,
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }],
    }), { status: 200 }),
  });
  await assert.rejects(duplicate.embed(['第一段', '第二段']), /序号不合法/);
});
