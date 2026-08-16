const assert = require('node:assert/strict');
const test = require('node:test');

const { createEventBus } = require('../src/services/event-bus');
const E = require('../src/contracts/events');

test('event-bus: on/emit 广播给多订阅者', () => {
  const bus = createEventBus();
  const seen = [];
  const off1 = bus.on(E.SENSING_TICK, (p) => seen.push(['a', p.now]));
  const off2 = bus.on(E.SENSING_TICK, (p) => seen.push(['b', p.now]));
  assert.equal(bus.listenerCount(E.SENSING_TICK), 2);
  assert.equal(bus.emit(E.SENSING_TICK, { now: 42 }), true);
  assert.deepEqual(seen, [['a', 42], ['b', 42]]);
  off1();
  off2();
});

test('event-bus: off 退订后不再触发', () => {
  const bus = createEventBus();
  let count = 0;
  const off = bus.on(E.SENSING_TICK, () => { count += 1; });
  bus.emit(E.SENSING_TICK, {});
  assert.equal(count, 1);
  off();
  bus.emit(E.SENSING_TICK, {});
  assert.equal(count, 1);
  assert.equal(bus.listenerCount(E.SENSING_TICK), 0);
});

test('event-bus: once 只触发一次并自动退订', () => {
  const bus = createEventBus();
  let count = 0;
  bus.once(E.SENSING_TICK, () => { count += 1; });
  bus.emit(E.SENSING_TICK, {});
  bus.emit(E.SENSING_TICK, {});
  assert.equal(count, 1);
  assert.equal(bus.listenerCount(E.SENSING_TICK), 0);
});

test('event-bus: 单订阅者抛错不影响其他订阅者', () => {
  const bus = createEventBus();
  const seen = [];
  // 用 stub 吞掉 console.error，避免测试输出噪音
  const origErr = console.error;
  console.error = () => {};
  try {
    bus.on(E.SENSING_TICK, () => { throw new Error('boom'); });
    bus.on(E.SENSING_TICK, () => { seen.push('ok'); });
    assert.equal(bus.emit(E.SENSING_TICK, {}), true);
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(seen, ['ok']);
  assert.equal(bus.listenerCount(E.SENSING_TICK), 2); // 出错的订阅者仍保留
});

test('event-bus: 未订阅事件 emit 返回 false', () => {
  const bus = createEventBus();
  assert.equal(bus.emit(E.SENSING_TICK, {}), false);
});

test('event-bus: on 传非函数抛错', () => {
  const bus = createEventBus();
  assert.throws(() => bus.on(E.SENSING_TICK, 'nope'), /必须是函数/);
});

test('event-bus: 派发过程中的退订不影响本轮快照', () => {
  const bus = createEventBus();
  const seen = [];
  const offA = bus.on(E.SENSING_TICK, () => seen.push('a'));
  bus.on(E.SENSING_TICK, () => {
    seen.push('b');
    offA(); // 本轮内退订 a，不应中断当前轮
  });
  bus.emit(E.SENSING_TICK, {});
  assert.deepEqual(seen, ['a', 'b']);
  bus.emit(E.SENSING_TICK, {}); // 下一轮 a 已被退订
  assert.deepEqual(seen, ['a', 'b', 'b']);
});

test('event-bus: clear 清空所有订阅', () => {
  const bus = createEventBus();
  let count = 0;
  bus.on(E.SENSING_TICK, () => { count += 1; });
  bus.clear();
  bus.emit(E.SENSING_TICK, {});
  assert.equal(count, 0);
});
