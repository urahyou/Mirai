const assert = require('node:assert/strict');
const test = require('node:test');

const generic = require('../src/engine/generic');

const BASE = 'https://api.test.example/v1';
const MODEL = 'deepseek-v4-flash';
const PROVIDER = { baseUrl: BASE, defaultModel: MODEL, temperature: 0.8, topP: 0.9 };

// 构造 N 个一来一回的对话轮（每条约 120 字，估 token 足够吃掉预算）
function buildHistory(turns, prefix = '') {
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    const body = `我今天去了图书馆认真复习了好几个小时，中间遇到一件蛮开心的小事想跟你聊聊，另外还想起下午那杯没喝完的咖啡放在哪里了，你有没有印象？`.repeat(6);
    msgs.push({ role: 'user', content: `${prefix}主人第${i}轮：${body}` });
    const reply = `那很好呀主人，记得劳逸结合别太辛苦，晚上早点休息，明天才有精神继续加油，我会一直陪着你听你讲的。`.repeat(6);
    msgs.push({ role: 'assistant', content: `${prefix}小未来第${i}轮：${reply}` });
  }
  return msgs;
}

// 计数器：只统计"真正打到 /chat/completions 的摘要请求"
function mockFetch(requests) {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '这是压缩后的：主人备考研究生、养猫叫团子、经常熬夜失眠。' } }] }),
    };
  };
  return () => { global.fetch = realFetch; };
}

test('Given 历史超过 80% 预算 When 生成回复 Then 早期对话被压成摘要并保留最近对话', async (t) => {
  const calls = [];
  const restore = mockFetch(calls);
  t.after(restore);

  const pendingHistory = buildHistory(20); // 约 40 条，估 token 远超 2000
  const budget = 2000;                     // recentBudget = max(2000, 700) = 2000

  const result = await generic.buildCompressedHistory(pendingHistory, budget, PROVIDER);

  // 摘要系统消息在最前
  assert.ok(result.summarizedTurns > 0, `应压缩早期若干轮，实际 summarizedTurns=${result.summarizedTurns}`);
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[0].content, /^\[对话前期摘要\]/);
  // 保留了最近对话（user/assistant 交替），且最后一条是最近那轮的 assistant
  const kept = result.messages.slice(1);
  assert.ok(kept.length >= 2);
  assert.equal(kept[kept.length - 1].content, pendingHistory[pendingHistory.length - 1].content);
  // 摘要请求确实发给了 LLM
  assert.ok(calls.some((c) => String(c.url).includes('/chat/completions')));
});

test('Given 相同早期对话被重复压缩 When 再次生成 Then 摘要走缓存不再调 LLM', async (t) => {
  const calls = [];
  const restore = mockFetch(calls);
  t.after(restore);

  const pendingHistory = buildHistory(20);
  const budget = 2000;

  await generic.buildCompressedHistory(pendingHistory, budget, PROVIDER);
  const firstCallCount = calls.length;
  await generic.buildCompressedHistory(pendingHistory, budget, PROVIDER);
  assert.equal(calls.length, firstCallCount, '相同摘要前缀应命中缓存，不重复调用 LLM');
});

test('Given 历史未达 80% 预算 When 压缩 When 早期对话太少 Then 回退并 summarizedTurns=0', async (t) => {
  const calls = [];
  const restore = mockFetch(calls);
  t.after(restore);

  // 预算极大，recentBudget=2000 能装下全部 → 没有可摘要的早期对话
  const pendingHistory = buildHistory(2);
  const result = await generic.buildCompressedHistory(pendingHistory, 2000, PROVIDER);
  assert.equal(result.summarizedTurns, 0);
  assert.equal(result.messages[0].role, 'user'); // 没有被插入摘要系统消息
  assert.equal(calls.length, 0, '早期对话太少不应触发摘要调用');
});

test('Given 摘要 LLM 失败 When 生成回复 Then 捕获异常不会抛出', async (t) => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  t.after(() => { global.fetch = realFetch; });

  const pendingHistory = buildHistory(20);
  const budget = 2000;
  const result = await generic.buildCompressedHistory(pendingHistory, budget, PROVIDER);
  // 失败时走内部 fallback：仍返回可用的 messages（截断）而非抛出
  assert.ok(Array.isArray(result.messages) && result.messages.length > 0);
});
