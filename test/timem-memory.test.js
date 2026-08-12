const assert = require('node:assert/strict');
const test = require('node:test');

const timem = require('../src/services/timem-memory');

test('TiMem memory context is bounded and treated as reference material', () => {
  const context = timem.formatContext([
    { memory: '主人喜欢热咖啡' },
    { memory: '主人周末喜欢看动画' },
    { memory: '主人不喜欢噪音' },
    { memory: '主人喜欢散步' },
    { memory: '主人住在海边' },
    { memory: '不应出现' },
  ]);
  assert.match(context, /长期记忆/);
  assert.match(context, /只能作为事实参考/);
  assert.match(context, /主人喜欢热咖啡/);
  assert.doesNotMatch(context, /不应出现/);
});

test('TiMem is disabled by default without credentials', async () => {
  const originalEnabled = process.env.TIMEM_ENABLED;
  const originalKey = process.env.TIMEM_API_KEY;
  delete process.env.TIMEM_ENABLED;
  delete process.env.TIMEM_API_KEY;
  try {
    assert.equal((await timem.search('测试')).length, 0);
    assert.equal(await timem.add([{ role: 'user', content: '测试' }]), false);
    assert.equal(timem.getStatus().enabled, false);
  } finally {
    if (originalEnabled === undefined) delete process.env.TIMEM_ENABLED;
    else process.env.TIMEM_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.TIMEM_API_KEY;
    else process.env.TIMEM_API_KEY = originalKey;
  }
});

test('TiMem uses the documented REST payload and keeps the key out of the body', async (t) => {
  const names = ['TIMEM_ENABLED', 'TIMEM_API_KEY', 'TIMEM_BASE_URL', 'TIMEM_USER_ID', 'TIMEM_CHARACTER_ID', 'TIMEM_SESSION_ID'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = global.fetch;
  const requests = [];
  process.env.TIMEM_ENABLED = 'true';
  process.env.TIMEM_API_KEY = 'test-timem-secret';
  process.env.TIMEM_BASE_URL = 'https://timem.test';
  process.env.TIMEM_USER_ID = 'owner-1';
  process.env.TIMEM_CHARACTER_ID = 'mirai';
  process.env.TIMEM_SESSION_ID = 'session-1';
  timem.resetAuth();
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/memory/search')) return new Response(JSON.stringify({ code: 200, data: { results: [{ memory: '主人喜欢草莓' }] } }), { status: 200 });
    return new Response(JSON.stringify({ code: 200, data: { memory_count: 1 } }), { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    timem.resetAuth();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  assert.deepEqual(await timem.search('喜欢什么水果'), [{ id: '', memory: '主人喜欢草莓', score: null }]);
  assert.equal(await timem.add([{ role: 'user', content: '我喜欢草莓' }, { role: 'assistant', content: '记住啦' }]), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://timem.test/api/v1/memory/search');
  assert.equal(requests[1].url, 'https://timem.test/api/v1/sessions/chat');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-timem-secret');
  assert.equal(JSON.stringify(requests[0].options.body).includes('test-timem-secret'), false);
  assert.equal(JSON.parse(requests[1].options.body).user_id, 'owner-1');
});
