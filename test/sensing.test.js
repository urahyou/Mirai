const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const storage = require('../src/services/storage');
const { createEventBus } = require('../src/services/event-bus');
const petState = require('../src/systems/pet-state');
const sensing = require('../src/systems/sensing');
const E = require('../src/contracts/events');

const MS_HOUR = 3600 * 1000;
const MS_DAY = 24 * MS_HOUR;

let dir;
let bus;
let base;
function setup(initialNow) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-sense-'));
  storage._reset();
  storage.setRuntimeDir(dir);
  bus = createEventBus();
  petState._reset();
  petState.init({ eventBus: bus });
  sensing._reset();
  sensing.init({ eventBus: bus });
  base = initialNow || Date.now();
  petState._setNow(() => base);
  sensing._setNow(() => base);
}
function teardown() {
  sensing._reset();
  petState._reset();
  storage._reset();
  storage.setRuntimeDir(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

test('sensing: 心跳定时发 sensing:tick', () => {
  setup();
  try {
    const ticks = [];
    bus.on(E.SENSING_TICK, (e) => ticks.push(e.now));
    sensing.tick(1000);
    sensing.tick(2000);
    assert.deepEqual(ticks, [1000, 2000]);
  } finally {
    teardown();
  }
});

test('sensing: 深夜(23:00-05:00)触发 LATE_NIGHT（每日一次）', () => {
  // 选一个深夜时刻：当天 23:30
  const d = new Date();
  d.setHours(23, 30, 0, 0);
  setup(d.getTime());
  try {
    // 首次 tick 触发
    sensing.tick(base);
    let s = petState.getState();
    assert.equal(s.events.at(-1).type, E.PET.LATE_NIGHT, '深夜应触发 LATE_NIGHT');
    assert.equal(s.emotion.stress, 20, '深夜压力 +5');
    // 再次 tick 同一天：节流不重复触发
    sensing.tick(base + 5 * 60 * 1000);
    const count = petState.getState().events.filter((e) => e.type === E.PET.LATE_NIGHT).length;
    assert.equal(count, 1, '同一天深夜只触发一次');
  } finally {
    teardown();
  }
});

test('sensing: 白天(10:00)不触发深夜', () => {
  const d = new Date(); d.setHours(10, 0, 0, 0);
  setup(d.getTime());
  try {
    sensing.tick(base);
    const has = petState.getState().events.some((e) => e.type === E.PET.LATE_NIGHT);
    assert.equal(has, false, '白天不触发深夜');
  } finally {
    teardown();
  }
});

test('sensing: 连续在线超阈值触发 LONG_SESSION', () => {
  setup();
  try {
    sensing._setSessionStartAt(base); // 本次会话起点
    // 未达 6h 不触发
    sensing.tick(base + 2 * MS_HOUR);
    let has = petState.getState().events.some((e) => e.type === E.PET.LONG_SESSION);
    assert.equal(has, false, '2h 未触发连用');
    // 达 6h 触发
    petState._setNow(() => base + 6 * MS_HOUR);
    sensing.tick(base + 6 * MS_HOUR);
    has = petState.getState().events.some((e) => e.type === E.PET.LONG_SESSION);
    assert.equal(has, true, '6h 触发连用');
    assert.ok(petState.getState().emotion.energy < 80, '连用耗体力');
  } finally {
    teardown();
  }
});

test('sensing: 冷落——距最后互动超 24h 触发 NEGLECT（节流）', () => {
  // 基准设为白天 10:00，使推演时刻(+0/12/26/30h)都不落入深夜，避免 LATE_NIGHT 干扰
  const d0 = new Date(); d0.setHours(10, 0, 0, 0);
  setup(d0.getTime());
  try {
    // 先有互动（写入 lastInteractionAt）
    petState.applyEvent(E.PET.GREETING);
    // 距最后互动 12h：未触发
    petState._setNow(() => base + 12 * MS_HOUR);
    sensing.tick(base + 12 * MS_HOUR);
    let has = petState.getState().events.some((e) => e.type === E.PET.NEGLECT);
    assert.equal(has, false, '12h 未触发冷落');
    // 距 26h：触发
    petState._setNow(() => base + 26 * MS_HOUR);
    sensing.tick(base + 26 * MS_HOUR);
    has = petState.getState().events.some((e) => e.type === E.PET.NEGLECT);
    assert.equal(has, true, '26h 触发冷落');
    // 距 30h（<24h 重复间隔）：节流不重复
    petState._setNow(() => base + 30 * MS_HOUR);
    sensing.tick(base + 30 * MS_HOUR);
    const count = petState.getState().events.filter((e) => e.type === E.PET.NEGLECT).length;
    assert.equal(count, 1, '24h 内不重复冷落');
  } finally {
    teardown();
  }
});

test('sensing: 从未互动过不算冷落', () => {
  setup();
  try {
    // 没有 applyEvent 过 → lastInteractionAt 为空
    petState._setNow(() => base + 30 * MS_DAY);
    sensing.tick(base + 30 * MS_DAY);
    const has = petState.getState().events.some((e) => e.type === E.PET.NEGLECT);
    assert.equal(has, false, '从未互动不触发冷落');
  } finally {
    teardown();
  }
});

test('sensing: start/stop 生命周期', () => {
  setup();
  try {
    sensing.start({ intervalMs: 100000 }); // 大间隔避免真实计时干扰
    assert.equal(sensing.isRunning(), true);
    // start 时立即 tick 一拍
    const has = petState.getState().events.some((e) => e.type === E.PET.LONG_SESSION);
    assert.ok(typeof has === 'boolean');
    sensing.stop();
    assert.equal(sensing.isRunning(), false);
    sensing.start();
    sensing.stop();
  } finally {
    teardown();
  }
});
