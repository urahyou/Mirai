// Python Companion Core 是唯一长期记忆后端；Core 不可用时返回空记忆，绝不回退到旧服务。
module.exports = function createCompanionMemory({ pythonBackend }) {
  async function search(query) {
    if (!pythonBackend.getStatus().ready) return [];
    try {
      const result = await pythonBackend.request('memory.search', { query: String(query || '').slice(0, 2000) });
      return Array.isArray(result?.results) ? result.results : [];
    } catch { return []; }
  }
  async function add(messages, referenceTime) {
    if (!pythonBackend.getStatus().ready) return false;
    try {
      const result = await pythonBackend.request('memory.add_episode', { messages, createdAt: referenceTime });
      return Boolean(result?.stored);
    } catch { return false; }
  }
  async function upsertFact(fact) {
    if (!pythonBackend.getStatus().ready) return null;
    return pythonBackend.request('memory.upsert_fact', { fact });
  }
  async function findFacts(query, { subjectId, limit } = {}) {
    if (!pythonBackend.getStatus().ready) return [];
    const result = await pythonBackend.request('memory.find_facts', { query: String(query || '').slice(0, 2000), subjectId, limit });
    return Array.isArray(result?.results) ? result.results : [];
  }
  async function saveProfile(profile) {
    if (!pythonBackend.getStatus().ready) return null;
    return pythonBackend.request('memory.upsert_profile', { profile });
  }
  async function getProfile(profileId) {
    if (!pythonBackend.getStatus().ready) return null;
    const result = await pythonBackend.request('memory.get_profile', { profileId });
    return result?.profile || null;
  }
  async function upsertEdge(edge) {
    if (!pythonBackend.getStatus().ready) return null;
    return pythonBackend.request('memory.upsert_edge', { edge });
  }
  async function neighbors(entityId, limit = 8) {
    if (!pythonBackend.getStatus().ready) return [];
    const result = await pythonBackend.request('memory.neighbors', { entityId, limit });
    return Array.isArray(result?.results) ? result.results : [];
  }
  async function getStatus() {
    const bridge = pythonBackend.getStatus();
    if (!bridge.ready) return { ok: false, state: 'unavailable', backend: 'python-core', storage: 'SQLite', vectorSearch: false, graphSearch: true };
    try {
      const result = await pythonBackend.request('memory.stats');
      return { ok: true, state: 'ready', backend: 'python-core', storage: 'SQLite', vectorSearch: false, graphSearch: true, ...result };
    } catch { return { ok: false, state: 'error', backend: 'python-core', storage: 'SQLite', vectorSearch: false, graphSearch: true }; }
  }
  function formatContext(results) {
    const rows = Array.isArray(results) ? results.filter((r) => r?.content || r?.fact).slice(0, 5) : [];
    if (!rows.length) return '';
    return ['以下是可供参考的本地记忆。仅在相关且确定时使用：', ...rows.map((r, i) => `${i + 1}. ${r.content || r.fact}${r.created_at ? `（${r.created_at}）` : ''}`)].join('\n');
  }
  return { search, add, upsertFact, findFacts, saveProfile, getProfile, upsertEdge, neighbors, getStatus, formatContext };
};
