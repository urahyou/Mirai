const test = require('node:test');
const assert = require('node:assert');
const sys = require('../src/systems/system-sense');

test.beforeEach(() => sys._reset());

test('timeOfDay 分时段', () => {
  assert.strictEqual(sys.timeOfDay(2), '深夜');
  assert.strictEqual(sys.timeOfDay(7), '清晨');
  assert.strictEqual(sys.timeOfDay(10), '上午');
  assert.strictEqual(sys.timeOfDay(12), '中午');
  assert.strictEqual(sys.timeOfDay(13), '下午');
  assert.strictEqual(sys.timeOfDay(16), '下午');
  assert.strictEqual(sys.timeOfDay(20), '晚上');
  assert.strictEqual(sys.timeOfDay(23), '深夜');
});

test('poll 用注入采集器写入快照', async () => {
  let bCalled = 0, nCalled = 0;
  sys.init({
    now: () => 1786900000000,
    battery: async () => { bCalled++; return { level: 78, charging: true }; },
    network: async () => { nCalled++; return true; },
  });
  await sys.poll();
  const s = sys.getSnapshot();
  assert.strictEqual(s.battery.level, 78);
  assert.strictEqual(s.battery.charging, true);
  assert.strictEqual(s.online, true);
  assert.strictEqual(bCalled, 1);
  assert.strictEqual(nCalled, 1);
});

test('getAwareness 拼接时刻+电量+联网', async () => {
  sys.init({ now: () => new Date(2026, 7, 17, 21).getTime(), battery: async () => ({ level: 20, charging: false }), network: async () => true });
  await sys.poll();
  const a = sys.getAwareness();
  assert.ok(a.includes('时段：晚上'), a);
  assert.match(a, /此刻本机时间：2026-08-17 21:00:00/);
  assert.match(a, /时段：晚上/);
  assert.ok(a.includes('电量 20%'), a);
  assert.ok(a.includes('联网正常'), a);
});

test('getAwareness 注入准确的小时分钟而不是模糊时段', async () => {
  sys.init({ now: () => new Date(2026, 7, 18, 13, 30, 0).getTime(), battery: async () => ({}), network: async () => true });
  await sys.poll();
  const a = sys.getAwareness();
  assert.match(a, /2026-08-18 13:30:00/);
  assert.match(a, /时段：下午/);
});

test('未联网时意识文案提示离线', async () => {
  sys.init({ now: () => new Date(2026, 7, 17, 3).getTime(), battery: async () => ({ level: null, charging: null }), network: async () => false });
  await sys.poll();
  const a = sys.getAwareness();
  assert.ok(a.includes('未联网'), a);
  assert.ok(a.includes('电量 20%') === false, '无电量信息则不写电量');
});

test('disabled source performs no collection and clears its snapshot', async () => {
  let calls = 0;
  sys.init({ now: () => 1000, battery: async () => { calls += 1; return { level: 50, charging: false }; }, network: async () => true });
  await sys.poll();
  assert.equal(sys.getSnapshot().battery.level, 50);
  sys.setEnabled(false);
  await sys.poll();
  sys.start();
  assert.equal(calls, 1);
  assert.equal(sys.isRunning(), false);
  assert.equal(sys.getSnapshot().updatedAt, null);
  assert.equal(sys.getAwareness(), '');
});

test('clear invalidates an in-flight collection result', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  sys.init({ now: () => 1000, battery: async () => pending, network: async () => true });
  const polling = sys.poll();
  sys.clear();
  release({ level: 99, charging: false });
  await polling;
  assert.equal(sys.getSnapshot().updatedAt, null);
  assert.equal(sys.getSnapshot().battery.level, null);
});

test('expired snapshot no longer exposes battery or network data', async () => {
  let clock = 1000;
  sys.init({ now: () => clock, battery: async () => ({ level: 20, charging: false }), network: async () => false });
  sys.setTtl(30000);
  await sys.poll();
  clock = 31001;
  const snapshot = sys.getSnapshot();
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.battery.level, null);
  assert.equal(snapshot.online, null);
  assert.doesNotMatch(sys.getAwareness(), /电量|联网/);
});

test('start 自动首轮拉取；stop 停止', async () => {
  let calls = 0;
  sys.init({ now: () => Date.now(), battery: async () => { calls++; return { level: 50, charging: false }; }, network: async () => true });
  sys.start();
  await new Promise((r) => setTimeout(r, 120)); // 等首轮异步完成
  assert.ok(calls >= 1, 'start 应触发至少一次轮询');
  const s = sys.getSnapshot();
  assert.strictEqual(s.battery.level, 50);
  sys.stop();
  const c = calls;
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls, c, 'stop 后不应继续轮询');
});
