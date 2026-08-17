// Python 本地记忆优先；Core 不可用时保留既有 Graphiti 降级，避免聊天中断。
module.exports = function createCompanionMemory({ pythonBackend, fallback }) {
  async function search(query) {
    if (!pythonBackend.getStatus().ready) return fallback.search(query);
    try {
      const result = await pythonBackend.request('memory.search', { query: String(query || '').slice(0, 2000) });
      return Array.isArray(result?.results) ? result.results : [];
    } catch { return fallback.search(query); }
  }
  async function add(messages, referenceTime) {
    if (!pythonBackend.getStatus().ready) return fallback.add(messages, referenceTime);
    try {
      const result = await pythonBackend.request('memory.add_episode', { messages, createdAt: referenceTime });
      return Boolean(result?.stored);
    } catch { return fallback.add(messages, referenceTime); }
  }
  function formatContext(results) {
    const rows = Array.isArray(results) ? results.filter((r) => r?.content || r?.fact).slice(0, 5) : [];
    if (!rows.length) return '';
    return ['以下是可供参考的本地记忆。仅在相关且确定时使用：', ...rows.map((r, i) => `${i + 1}. ${r.content || r.fact}${r.created_at ? `（${r.created_at}）` : ''}`)].join('\n');
  }
  return { search, add, formatContext };
};
