const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadableStream } = require('node:stream/web');
const test = require('node:test');

const generic = require('../src/engine/generic');
const rules = require('../src/engine/rules');
const personalityRuntime = require('../src/services/personality-runtime');

test('Given a Provider API key When configuration is saved Then the key goes to dotenv and not runtime config', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-provider-secret-'));
  const runtimeFile = path.join(dir, 'llm-providers.runtime.json');
  const dotenvFile = path.join(dir, '.env');
  t.after(() => {
    generic.setRuntimePath(null);
    generic.setDotEnvPath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  generic.setRuntimePath(runtimeFile);
  generic.setDotEnvPath(dotenvFile);
  const secret = 'sk-test-secret';
  const result = generic.saveProviderConfig({
    activeProvider: 'cloud',
    providers: {
      cloud: {
        label: 'Cloud',
        baseUrl: 'https://api.example.test/v1',
        defaultModel: 'deepseek-v4-flash',
        apiKey: secret,
        temperature: 0.8,
        topP: 0.9,
      },
    },
  });

  assert.match(fs.readFileSync(dotenvFile, 'utf8'), /MIRAI_PROVIDER_CLOUD_API_KEY=sk-test-secret/);
  assert.doesNotMatch(fs.readFileSync(runtimeFile, 'utf8'), /sk-test-secret/);
  assert.equal(result.providers.cloud.apiKeyConfigured, true);
});

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

test('Given a saved runtime personality When the next chat starts Then the new persona replaces old conversation influence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-personality-'));
  const runtimeFile = path.join(dir, 'personality-runtime.json');
  const originalFetch = global.fetch;
  const requests = [];
  personalityRuntime.setRuntimePath(runtimeFile);
  personalityRuntime.setPersonality({
    name: '测试未来',
    personality: {
      mood: '安静',
      age: '17',
      likes: ['月亮'],
      dislikes: ['吵闹'],
      catchphrases: ['收到'],
      tone: '冷静、简洁',
      selfIntro: '我是测试未来。',
    },
  });
  rules.resetConfig();
  generic.resetConversationHistory();
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: '收到' } }] }), { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    generic.resetConversationHistory();
    personalityRuntime.setRuntimePath(null);
    rules.resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await generic.generateReply('请介绍自己');

  const body = JSON.parse(requests[0].options.body);
  assert.match(body.messages[0].content, /测试未来/);
  assert.match(body.messages[0].content, /冷静、简洁/);
  assert.match(body.messages[0].content, /收到/);
  assert.deepEqual(body.messages.slice(1), [{ role: 'user', content: '请介绍自己' }]);
});
