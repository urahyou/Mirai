// Python 生活状态的只读摘要与受控推进；现实行为仍必须经 Node Agent Gateway 审批。
module.exports = function createCompanionLife({ pythonBackend }) {
  let cache = null;
  let queue = Promise.resolve();
  function getState() { return cache; }
  function describe() {
    if (!cache) return '';
    const activity = cache.currentActivityId || 'rest';
    return `生活状态：正在${activity}；地点 ${cache.location || 'home'}；健康 ${Math.round(cache.health || 0)}/100；体力 ${Math.round(cache.energy || 0)}/100；饥饿 ${Math.round(cache.hunger || 0)}/100；无聊 ${Math.round(cache.boredom || 0)}/100。`;
  }
  function advance(now = Date.now()) {
    if (!pythonBackend.getStatus().ready) return Promise.resolve(cache);
    queue = queue.catch(() => {}).then(async () => {
      cache = await pythonBackend.request('life.advance', { now });
      return cache;
    });
    return queue;
  }
  function performActivity(activityId, now = Date.now()) {
    if (!pythonBackend.getStatus().ready) return Promise.reject(new Error('Python 生活后端未就绪'));
    queue = queue.catch(() => {}).then(async () => {
      cache = await pythonBackend.request('life.perform_activity', { activityId, now });
      return cache;
    });
    return queue;
  }
  function whenIdle() { return queue; }
  return { getState, describe, advance, performActivity, whenIdle };
};
