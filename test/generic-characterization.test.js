const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const test = require('node:test');

const generic = require('../src/engine/generic');

test('Given the configured active provider When probed successfully Then detection returns true without authorization', async (t) => {
  const originalFetch = global.fetch;
  const [providerName] = generic.providerChain();
  const provider = generic.loadProviders().providers[providerName];
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response('', { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  assert.equal(await generic.isAvailable(providerName), true);
  assert.equal(request.url, `${provider.baseUrl.replace(/\/$/, '')}/models`);
  const apiKey = provider.apiKey;
  const expectedHeaders = apiKey && !['none', 'EMPTY', 'empty'].includes(apiKey)
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  assert.deepEqual(request.options.headers, expectedHeaders);
});

test('Given streamed provider output When generic chat runs Then it emits cumulative deltas and returns complete text', async (t) => {
  const originalFetch = global.fetch;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(body, { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  const deltas = [];

  const reply = await generic.generateReply('测试流式回复', {
    onDelta: (chunk, full) => deltas.push({ chunk, full }),
  });

  assert.equal(reply, '你好');
  assert.deepEqual(deltas, [{ chunk: '你', full: '你' }, { chunk: '好', full: '你好' }]);
  assert.equal(JSON.parse(requests[0].options.body).stream, true);
});

test('Given a stream whose final SSE record has no trailing newline When generic chat runs Then the final delta is preserved', async (t) => {
  const originalFetch = global.fetch;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"尾包"}}]}'));
      controller.close();
    },
  });
  global.fetch = async () => new Response(body, { status: 200 });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const reply = await generic.generateReply('测试无换行尾包', { onDelta: () => {} });

  assert.equal(reply, '尾包');
});
