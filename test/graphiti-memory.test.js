const assert = require('node:assert/strict');
const test = require('node:test');

const graphiti = require('../src/services/graphiti-memory');

test('Graphiti context preserves temporal metadata and stays bounded', () => {
  const context = graphiti.formatContext([
    { fact: '主人最近想吃水果', valid_at: '2026-08-15T15:31:00Z' },
    { fact: '主人喜欢看书', created_at: '2026-08-14T12:00:00Z' },
    { fact: '不应出现' },
    { fact: '不应出现2' },
    { fact: '不应出现3' },
    { fact: '不应出现4' },
    { fact: '不应出现5' },
    { fact: '不应出现6' },
    { fact: '不应出现7' },
  ]);
  assert.match(context, /时序关系记忆/);
  assert.match(context, /主人最近想吃水果/);
  assert.match(context, /2026-08-15/);
  assert.doesNotMatch(context, /不应出现7/);
});

test('Graphiti is disabled by default and does not call the sidecar', async (t) => {
  const previous = process.env.GRAPHITI_ENABLED;
  const originalFetch = global.fetch;
  process.env.GRAPHITI_ENABLED = 'false';
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not be called'); };
  t.after(() => {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.GRAPHITI_ENABLED;
    else process.env.GRAPHITI_ENABLED = previous;
  });
  assert.deepEqual(await graphiti.search('水果'), []);
  assert.equal(await graphiti.add([{ role: 'user', content: '水果' }]), false);
  assert.equal(called, false);
});

test('Graphiti health reports disabled and unreachable states without throwing', async (t) => {
  const previous = process.env.GRAPHITI_ENABLED;
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.GRAPHITI_ENABLED;
    else process.env.GRAPHITI_ENABLED = previous;
  });

  process.env.GRAPHITI_ENABLED = 'false';
  assert.deepEqual(await graphiti.health(), { ok: false, state: 'disabled' });

  process.env.GRAPHITI_ENABLED = 'true';
  global.fetch = async () => { throw new Error('connection refused'); };
  const status = await graphiti.health();
  assert.equal(status.ok, false);
  assert.equal(status.state, 'unreachable');
  assert.match(status.error, /connection refused/);
});

test('Graphiti adapter sends group, reference time, and normalized episode', async (t) => {
  const names = ['GRAPHITI_ENABLED', 'GRAPHITI_BASE_URL', 'GRAPHITI_GROUP_ID'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = global.fetch;
  const requests = [];
  process.env.GRAPHITI_ENABLED = 'true';
  process.env.GRAPHITI_BASE_URL = 'http://graphiti.test';
  process.env.GRAPHITI_GROUP_ID = 'owner-test';
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true, results: [{ fact: '主人最近想吃水果' }] }), { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  assert.equal(await graphiti.add([
    { role: 'user', content: ' 我想吃水果 ' },
    { role: 'assistant', content: '好的' },
    { role: 'system', content: 'ignore' },
  ], '2026-08-15T15:31:00.000Z'), true);
  assert.deepEqual(await graphiti.search('水果'), [{ fact: '主人最近想吃水果' }]);
  assert.equal(requests[0].url, 'http://graphiti.test/episode');
  assert.equal(JSON.parse(requests[0].options.body).group_id, 'owner-test');
  assert.equal(JSON.parse(requests[0].options.body).reference_time, '2026-08-15T15:31:00.000Z');
  assert.deepEqual(JSON.parse(requests[0].options.body).messages, [
    { role: 'user', content: '我想吃水果' },
    { role: 'assistant', content: '好的' },
  ]);
  assert.equal(requests[1].url, 'http://graphiti.test/search');
});
