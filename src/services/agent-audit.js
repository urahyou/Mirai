const crypto = require('crypto');

const MAX_ENTRIES = 200;

module.exports = function createAgentAudit({ now = () => Date.now(), capacity = MAX_ENTRIES, onRecord = () => {} } = {}) {
  const limit = Math.max(10, Math.min(1000, Number.parseInt(capacity, 10) || MAX_ENTRIES));
  const entries = [];

  function record(type, data = {}) {
    const entry = {
      id: `agent-audit:${crypto.randomUUID()}`,
      type: String(type || '').slice(0, 80),
      occurredAt: new Date(now()).toISOString(),
      taskId: typeof data.taskId === 'string' ? data.taskId : null,
      capability: typeof data.capability === 'string' ? data.capability : null,
      state: typeof data.state === 'string' ? data.state : null,
      reason: typeof data.reason === 'string' ? data.reason.slice(0, 300) : null,
      provider: typeof data.provider === 'string' ? data.provider.slice(0, 80) : null,
    };
    entries.unshift(entry);
    if (entries.length > limit) entries.length = limit;
    try { void Promise.resolve(onRecord({ ...entry })).catch(() => {}); } catch {}
    return { ...entry };
  }

  function list(count = 50) {
    const size = Math.max(1, Math.min(limit, Number.parseInt(count, 10) || 50));
    return entries.slice(0, size).map((entry) => ({ ...entry }));
  }

  function clear() { entries.length = 0; }

  return { record, list, clear };
};
