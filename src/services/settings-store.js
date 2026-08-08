const { createJsonStorage } = require('./json-storage');

const SCHEMA_VERSION = 1;

// 默认值全部本地优先 + 显式 opt-in。
const DEFAULTS = Object.freeze({
  notifications: true,
  sound: true,
  animation: true,
  reduceMotion: false,
  networkConsent: false,   // 默认不允许记忆/对话数据经网络传输
  memorySaving: true,
  memoryAuto: true,          // 自动记忆沉淀（Memory Judge）总开关，默认开启以保持现状
  memoryAutoInterval: 60000, // 自动沉淀最小间隔 ms（原硬编码 60s），可配置
  memorySoftDelete: true,    // 记忆删除先进回收站（软删），可还原
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  const next = {};
  for (const key of Object.keys(DEFAULTS)) {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') {
      next[key] = typeof settings[key] === 'boolean' ? settings[key] : def;
    } else if (typeof def === 'number') {
      next[key] = typeof settings[key] === 'number' && Number.isFinite(settings[key]) ? settings[key] : def;
    } else {
      next[key] = settings[key] == null ? def : settings[key];
    }
  }
  return next;
}

function createSettingsStore({ filePath }) {
  const storage = createJsonStorage({
    filePath,
    schemaVersion: SCHEMA_VERSION,
    defaults: DEFAULTS,
    migrate: () => clone(DEFAULTS),
  });

  function get() {
    return normalizeSettings(storage.load());
  }

  function set(settings) {
    const next = normalizeSettings({ ...get(), ...(settings || {}) });
    storage.save(next);
    return next;
  }

  function eraseAll() {
    storage.erase();
  }

  return Object.freeze({ get, set, eraseAll });
}

module.exports = { createSettingsStore, DEFAULTS };
