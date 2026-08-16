// 事件总线：感知源只 emit，领域系统只 on/once。
// - 同事件可多订阅者；只派发给订阅者（不全局广播到无关系统）
// - 单个订阅者抛错不影响其他订阅者（异常隔离）
// - 事件名一律引用 contracts/events.js 常量，杜绝字符串漂移
//
// 用法：
//   const { createEventBus } = require('./event-bus');
//   const bus = createEventBus();
//   const off = bus.on(E.SENSING_TICK, (payload, meta) => {});
//   ...
//   bus.emit(E.SENSING_TICK, { now: Date.now() });

function createEventBus() {
  // event -> Set<handler>
  const handlers = new Map();

  function on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('event handler 必须是函数');
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => off(event, handler);
  }

  function once(event, handler) {
    const wrapper = (payload, meta) => {
      off(event, wrapper);
      handler(payload, meta);
    };
    return on(event, wrapper);
  }

  function off(event, handler) {
    const set = handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) handlers.delete(event);
  }

  function emit(event, payload, meta) {
    const set = handlers.get(event);
    if (!set || set.size === 0) return false;
    // 快照遍历：派发过程中的 on/off 不影响本轮
    for (const handler of [...set]) {
      try {
        handler(payload, meta);
      } catch (err) {
        // 单订阅者异常隔离：不中断其他订阅者，仅记录
        // eslint-disable-next-line no-console
        console.error(`[event-bus] handler for "${event}" 抛错:`, err);
      }
    }
    return true;
  }

  function listenerCount(event) {
    return handlers.has(event) ? handlers.get(event).size : 0;
  }

  function clear() {
    handlers.clear();
  }

  return { on, once, off, emit, listenerCount, clear };
}

module.exports = { createEventBus };
