const storageDefault = require('./storage');

const KEY = 'perception-settings';
const CATALOG = Object.freeze({
  system: Object.freeze({ label: '系统状态', sensitivity: 'low', defaultEnabled: true, defaultTtlSeconds: 900 }),
  weather: Object.freeze({ label: '天气', sensitivity: 'low', defaultEnabled: false, defaultTtlSeconds: 1800 }),
  screen: Object.freeze({ label: '屏幕观察', sensitivity: 'high', defaultEnabled: false, defaultTtlSeconds: 300 }),
});
const DEFAULTS = Object.freeze({
  sources: Object.freeze(Object.fromEntries(Object.entries(CATALOG).map(([id, item]) => [id, {
    enabled: item.defaultEnabled,
    ttlSeconds: item.defaultTtlSeconds,
  }]))),
});

let storage = storageDefault;

function ttl(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(30, Math.min(86400, Math.round(parsed))) : fallback;
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const values = source.sources && typeof source.sources === 'object' && !Array.isArray(source.sources) ? source.sources : {};
  const sources = {};
  for (const [id, meta] of Object.entries(CATALOG)) {
    const current = values[id] && typeof values[id] === 'object' ? values[id] : {};
    sources[id] = {
      enabled: typeof current.enabled === 'boolean' ? current.enabled : meta.defaultEnabled,
      ttlSeconds: ttl(current.ttlSeconds, meta.defaultTtlSeconds),
    };
  }
  return { sources };
}

function init({ storage: injectedStorage } = {}) {
  storage = injectedStorage || storageDefault;
  storage.register(KEY, { version: 1, defaults: DEFAULTS, migrations: {}, normalize });
}

function getSource(id) {
  if (!Object.hasOwn(CATALOG, id)) return null;
  const value = storage.read(KEY).sources[id];
  return { id, ...CATALOG[id], ...value };
}

function listSources() {
  return Object.keys(CATALOG).map(getSource);
}

function setSource(id, patch) {
  if (!Object.hasOwn(CATALOG, id)) throw new TypeError('未知感知来源');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('感知设置必须是对象');
  if (!Object.keys(patch).every((key) => key === 'enabled' || key === 'ttlSeconds')) throw new TypeError('感知设置字段不合法');
  if (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') throw new TypeError('感知开关必须是布尔值');
  if (Object.hasOwn(patch, 'ttlSeconds') && (typeof patch.ttlSeconds !== 'number' || !Number.isFinite(patch.ttlSeconds))) throw new TypeError('感知 TTL 必须是数字');
  const state = storage.read(KEY);
  const current = state.sources[id];
  const next = {
    ...current,
    ...(Object.hasOwn(patch, 'enabled') ? { enabled: patch.enabled } : {}),
    ...(Object.hasOwn(patch, 'ttlSeconds') ? { ttlSeconds: patch.ttlSeconds } : {}),
  };
  storage.write(KEY, { ...state, sources: { ...state.sources, [id]: next } });
  return getSource(id);
}

function isEnabled(id) {
  return Boolean(getSource(id)?.enabled);
}

module.exports = { KEY, CATALOG, DEFAULTS, init, getSource, listSources, setSource, isEnabled, _normalize: normalize };
