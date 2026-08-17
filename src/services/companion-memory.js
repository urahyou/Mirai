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
  async function importMessages(messages) {
    if (!pythonBackend.getStatus().ready || !Array.isArray(messages)) return 0;
    const normalized = messages.slice(0, 10000).map((item) => ({
      id: item?.id, role: item?.role, content: item?.content,
      createdAt: Number.isFinite(item?.createdAt) ? new Date(item.createdAt).toISOString() : item?.createdAt,
    }));
    try {
      const result = await pythonBackend.request('memory.import_messages', { messages: normalized });
      return Number.isFinite(result?.inserted) ? result.inserted : 0;
    } catch { return 0; }
  }
  async function list(kind, limit = 30) {
    if (!pythonBackend.getStatus().ready) return [];
    try {
      const result = await pythonBackend.request('memory.list', { kind, limit });
      return Array.isArray(result?.results) ? result.results : [];
    } catch { return []; }
  }
  async function listMind(kind, limit = 30) {
    if (!pythonBackend.getStatus().ready) return [];
    try {
      const result = await pythonBackend.request('mind.list', { kind, limit });
      return Array.isArray(result?.results) ? result.results : [];
    } catch { return []; }
  }
  async function recordThought(thought) {
    if (!pythonBackend.getStatus().ready) return null;
    const result = await pythonBackend.request('mind.record_thought', { thought });
    return result?.thought || null;
  }
  async function recordDream(dream) {
    if (!pythonBackend.getStatus().ready) return null;
    const result = await pythonBackend.request('mind.record_dream', { dream });
    return result?.dream || null;
  }
  async function recordReflection(reflection) {
    if (!pythonBackend.getStatus().ready) return null;
    const result = await pythonBackend.request('mind.record_reflection', { reflection });
    return result?.reflection || null;
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
  async function buildDailyJournal(day, timezoneOffsetMinutes) {
    if (!pythonBackend.getStatus().ready) return null;
    return pythonBackend.request('journal.build_daily_material', { day, timezoneOffsetMinutes });
  }
  async function getDailyJournal(day) {
    if (!pythonBackend.getStatus().ready) return null;
    const result = await pythonBackend.request('journal.get_daily_material', { day });
    return result?.journal || null;
  }
  async function listDailyJournals(limit = 50) {
    if (!pythonBackend.getStatus().ready) return [];
    try {
      const result = await pythonBackend.request('journal.list_daily', { limit });
      return Array.isArray(result?.journals) ? result.journals : [];
    } catch { return []; }
  }
  async function saveDailyJournal(day, prose, reflection = null) {
    if (!pythonBackend.getStatus().ready) return null;
    const result = await pythonBackend.request('journal.save_daily_prose', { day, prose, reflection });
    return result?.journal || null;
  }
  function formatContext(results) {
    const rows = Array.isArray(results) ? results.filter((r) => r?.content || r?.fact).slice(0, 5) : [];
    if (!rows.length) return '';
    return ['以下是可供参考的本地记忆。仅在相关且确定时使用：', ...rows.map((r, i) => `${i + 1}. ${r.content || r.fact}${r.created_at ? `（${r.created_at}）` : ''}`)].join('\n');
  }
  return { search, add, importMessages, list, listMind, recordThought, recordDream, recordReflection, upsertFact, findFacts, saveProfile, getProfile, buildDailyJournal, getDailyJournal, listDailyJournals, saveDailyJournal, getStatus, formatContext };
};
