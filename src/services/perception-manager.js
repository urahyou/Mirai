module.exports = function createPerceptionManager({ settings, sources = {}, now = () => Date.now() }) {
  const known = new Map(Object.entries(sources));

  function sourceStatus(policy) {
    const source = known.get(policy.id);
    const snapshot = source?.getSnapshot?.() || null;
    const updatedAt = typeof snapshot?.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
      ? snapshot.updatedAt
      : null;
    const expiresAt = updatedAt !== null ? updatedAt + policy.ttlSeconds * 1000 : null;
    const stale = expiresAt !== null && expiresAt <= now();
    return {
      ...policy,
      available: Boolean(source && (source.isAvailable?.() ?? true)),
      running: Boolean(source?.isRunning?.()),
      permission: source?.getPermissionStatus?.() || (source ? 'granted' : 'unavailable'),
      updatedAt,
      expiresAt,
      stale,
      hasData: updatedAt !== null && !stale,
    };
  }

  function list() {
    return settings.listSources().map(sourceStatus);
  }

  function apply(id) {
    const policy = settings.getSource(id);
    const source = known.get(id);
    if (!policy || !source) return sourceStatus(policy || { id, enabled: false, ttlSeconds: 300 });
    source.setTtl?.(policy.ttlSeconds * 1000);
    source.setEnabled?.(policy.enabled);
    if (policy.enabled) source.start?.();
    else source.stop?.();
    return sourceStatus(policy);
  }

  function start() {
    for (const policy of settings.listSources()) apply(policy.id);
    return list();
  }

  function stop() {
    for (const source of known.values()) {
      source.setEnabled?.(false);
      source.stop?.();
    }
  }

  function set(id, patch) {
    const source = known.get(id);
    if (patch?.enabled === true && (!source || source.isAvailable?.() === false || source.getPermissionStatus?.() === 'not-configured')) throw new Error('感知来源当前不可用');
    settings.setSource(id, patch);
    return apply(id);
  }

  function clear(id) {
    const policy = settings.getSource(id);
    if (!policy) throw new TypeError('未知感知来源');
    known.get(id)?.clear?.();
    return sourceStatus(policy);
  }

  function get(id) {
    const policy = settings.getSource(id);
    return policy ? sourceStatus(policy) : null;
  }

  return { start, stop, list, get, set, clear };
};
