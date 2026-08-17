// Python 多维情绪缓存，仅用于呈现和提示词；状态改变只能经 Core 的领域事件发生。
module.exports = function createCompanionEmotion({ pythonBackend }) {
  let cache = null;
  let queue = Promise.resolve();
  function getState() { return cache; }
  function describe() {
    if (!cache) return '';
    const valence = cache.valence >= .6 ? '愉快' : cache.valence <= .35 ? '低落' : '平和';
    const arousal = cache.arousal >= .65 ? '活跃' : cache.arousal <= .35 ? '安静' : '平稳';
    return `情绪维度：${valence}、${arousal}；安全感 ${Math.round(cache.security * 100)}/100；依恋 ${Math.round(cache.attachment * 100)}/100；好奇 ${Math.round(cache.curiosity * 100)}/100；专注 ${Math.round(cache.focus * 100)}/100。`;
  }
  function refresh(now = Date.now()) {
    if (!pythonBackend.getStatus().ready) return Promise.resolve(cache);
    queue = queue.catch(() => {}).then(async () => {
      cache = await pythonBackend.request('emotion.get_state', { now });
      return cache;
    });
    return queue;
  }
  return { getState, describe, refresh, whenIdle: () => queue };
};
