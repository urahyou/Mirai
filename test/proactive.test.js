const test = require('node:test');
const assert = require('node:assert');
const proactive = require('../src/systems/proactive');
const E = require('../src/contracts/events');

// 每个用例用独立的大 epoch 时间，避免全局冷却(lastSay=0)把首个调用误判为冷却中。
const NOW = 1700000000000; // 2023-11 的毫秒级时间戳

test.beforeEach(() => {
  proactive._reset();
  proactive._setChance(1); // 默认确定性：仅“随机性”测试显式改 0
});

test('随机性：chance=0 时非强制事件不开口', () => {
  proactive._setChance(0);
  const r = proactive.consider({ type: E.PET.NEGLECT, now: NOW });
  assert.strictEqual(r.shouldAct, false);
});

test('NEGLECT 触发并返回关怀台词', () => {
  const r = proactive.consider({ type: E.PET.NEGLECT, now: NOW });
  assert.strictEqual(r.shouldAct, true);
  assert.ok(r.line && r.line.includes('主人'));
});

test('全局冷却：短时间内第二次不再开口', () => {
  const r1 = proactive.consider({ type: E.PET.NEGLECT, now: NOW });
  assert.strictEqual(r1.shouldAct, true);
  const r2 = proactive.consider({ type: E.PET.NEGLECT, now: NOW + 1000 }); // 1s 后
  assert.strictEqual(r2.shouldAct, false);
});

test('同类冷却：LATE_NIGHT 两次间隔太近不重复', () => {
  const r1 = proactive.consider({ type: E.PET.LATE_NIGHT, now: NOW });
  assert.strictEqual(r1.shouldAct, true);
  // 过了全局冷却(20min)但未过同类冷却(4h)
  const r2 = proactive.consider({ type: E.PET.LATE_NIGHT, now: NOW + 30 * 60 * 1000 });
  assert.strictEqual(r2.shouldAct, false);
});

test('STAGE_UP 强制触发，不受全局冷却影响', () => {
  // 先触发一次占据全局冷却（lastSay 由 maybeAct 才更新，这里用 maybeAct 模拟开口）
  let spoken = [];
  proactive.init({ say: (l) => spoken.push(l) });
  proactive.maybeAct({ type: E.PET.NEGLECT, now: NOW }); // 真开口，更新了 lastSay
  assert.strictEqual(spoken.length, 1);
  // 立即晋升：全局冷却虽未过，但 STAGE_UP 强制开口
  const r = proactive.consider({ type: E.PET.STAGE_UP, now: NOW + 5000 });
  assert.strictEqual(r.shouldAct, true);
  assert.ok(r.line.includes('长大'));
});

test('状态阈值：健康低时偶尔关怀', () => {
  const r = proactive.consider({ type: 'none', state: { emotion: { health: 10, loneliness: 20, moodScore: 60 } }, now: NOW });
  assert.strictEqual(r.shouldAct, true);
  assert.ok(r.line.includes('不舒服'));
});

test('无触发且状态健康时不行动', () => {
  const r = proactive.consider({ type: 'none', state: { emotion: { health: 80, loneliness: 10, moodScore: 70 } }, now: NOW });
  assert.strictEqual(r.shouldAct, false);
});

test('maybeAct 会调用 say 并返回台词', () => {
  let spoken = [];
  proactive.init({ eventBus: null, say: (l) => spoken.push(l) });
  const r = proactive.maybeAct({ type: E.PET.NEGLECT, now: NOW });
  assert.strictEqual(spoken.length, 1);
  assert.strictEqual(r, spoken[0]);
  // 全局冷却：再次 maybeAct 不再 say
  proactive.maybeAct({ type: E.PET.LATE_NIGHT, now: NOW + 1000 });
  assert.strictEqual(spoken.length, 1);
});

test('eventBus 订阅：事件触发自动 say', () => {
  const events = require('../src/services/event-bus');
  const bus = events.createEventBus();
  let spoken = [];
  proactive.init({ eventBus: bus, say: (l) => spoken.push(l) });
  bus.emit(E.PET.NEGLECT);
  bus.emit(E.PET.NEGLECT);
  assert.strictEqual(spoken.length, 1); // 冷却抑制第二次
  assert.ok(spoken[0].includes('主人'));
});
