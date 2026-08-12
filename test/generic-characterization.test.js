const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadableStream } = require('node:stream/web');
const test = require('node:test');

const generic = require('../src/engine/generic');

test('Given a runtime Provider path When configuration is saved Then the repository template is untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-provider-'));
  const runtimeFile = path.join(dir, 'llm-providers.runtime.json');
  const templateFile = path.join(__dirname, '..', 'src', 'core', 'llm-providers.json');
  const templateBefore = fs.readFileSync(templateFile, 'utf8');
  t.after(() => {
    generic.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  generic.setRuntimePath(runtimeFile);
  generic.saveProviderConfig({
    activeProvider: 'local',
    providers: {
      local: {
        label: 'Local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKeyEnv: 'MIRAI_PROVIDER_TEST_API_KEY',
        defaultModel: 'test-model',
        temperature: 0.8,
        topP: 0.9,
      },
    },
  });

  assert.equal(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).providers.local.apiKeyEnv, 'MIRAI_PROVIDER_TEST_API_KEY');
  assert.equal(fs.readFileSync(templateFile, 'utf8'), templateBefore);
});

test('Given the configured active provider When probed successfully Then detection returns true without authorization', async (t) => {
  const originalFetch = global.fetch;
  const [providerName] = generic.providerChain();
  const provider = generic.loadProviders().providers[providerName];
  const previousKey = process.env[provider.apiKeyEnv];
  process.env[provider.apiKeyEnv] = '';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response('', { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env[provider.apiKeyEnv];
    else process.env[provider.apiKeyEnv] = previousKey;
  });

  assert.equal(await generic.isAvailable(providerName), true);
  assert.equal(request.url, `${provider.baseUrl.replace(/\/$/, '')}/models`);
  assert.deepEqual(request.options.headers, {});
});

test('Given a Provider API key environment variable When probed Then only the request carries the secret', async (t) => {
  const originalFetch = global.fetch;
  const [providerName] = generic.providerChain();
  const provider = generic.loadProviders().providers[providerName];
  const previousKey = process.env[provider.apiKeyEnv];
  const secret = ['test', 'secret', 'not', 'persisted'].join('-');
  process.env[provider.apiKeyEnv] = secret;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response('', { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env[provider.apiKeyEnv];
    else process.env[provider.apiKeyEnv] = previousKey;
  });

  assert.equal(await generic.isAvailable(providerName), true);
  assert.deepEqual(request.options.headers, { Authorization: `Bearer ${secret}` });
  assert.equal(JSON.stringify(generic.getProviderConfig()).includes(secret), false);
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
