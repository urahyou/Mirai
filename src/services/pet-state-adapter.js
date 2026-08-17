// Python pet-state 优先的兼容适配器；同步读取使用缓存，Core 不可用时回退旧实现。
const E = require('../contracts/events');
module.exports = function createPetStateAdapter({ pythonBackend, fallback }) {
  let cache = null; let bus = null; let eventQueue = Promise.resolve();
  function init({ eventBus } = {}) { bus = eventBus || null; }
  function getState() { return cache || fallback.getState(); }
  function describe() { return fallback.describeFromState ? fallback.describeFromState(getState()) : fallback.describe(); }
  function applyEvent(type) {
    if (!pythonBackend.getStatus().ready) return fallback.applyEvent(type);
    const now = Date.now();
    // JSON-RPC 本身是异步的；串行化避免连续互动的旧响应覆盖新状态。
    eventQueue = eventQueue.catch(() => {}).then(async () => {
      try {
        const result = await pythonBackend.request('pet.apply_event', { eventType: type, now });
        cache = result.state;
        bus?.emit(type, { emotion: cache.emotion, affection: cache.affection, nurture: cache.nurture });
        if (result.stageUp) bus?.emit(E.PET.STAGE_UP, result.stageUp);
      } catch {
        cache = fallback.applyEvent(type);
      }
      return cache;
    });
    return getState();
  }
  async function seedFromLegacy() {
    if (!pythonBackend.getStatus().ready) return false;
    const result = await pythonBackend.request('pet.seed_if_empty', { state: fallback.getState() });
    cache = result.state; return Boolean(result.seeded);
  }
  function whenIdle() { return eventQueue; }
  return { init, getState, describe, applyEvent, seedFromLegacy, whenIdle };
};
