const { createJsonStorage } = require('./json-storage');

const SCHEMA_VERSION = 2;
const DEFAULTS = Object.freeze({ memories: [], blocked: [] });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 方案 C 分层记忆：为每条记忆补齐分层字段默认值（v1 → v2 迁移用）。
// 显式传入的字段优先，缺失时落到默认，因此不破坏既有 v1 记忆语义。
function withDefaults(memory) {
  if (!memory || typeof memory !== 'object') return memory;
  return {
    status: 'active',
    weight: typeof memory.importance === 'number' && memory.importance >= 0 && memory.importance <= 1 ? memory.importance : 0.5,
    accessCount: 0,
    isSummary: false,
    subEntryIds: [],
    conflictWith: [],
    embedding: undefined,
    ...memory,
  };
}

function normalize(data) {
  const document = data && typeof data === 'object' ? data : {};
  return {
    memories: Array.isArray(document.memories) ? clone(document.memories).map(withDefaults) : [],
    blocked: Array.isArray(document.blocked) ? clone(document.blocked) : [],
  };
}

function createMemoryStore({ filePath }) {
  const storage = createJsonStorage({
    filePath,
    schemaVersion: SCHEMA_VERSION,
    defaults: DEFAULTS,
    // v1 → v2：保留既有数据并补齐分层默认字段（勿用 DEFAULTS 清空用户记忆）。
    migrate: ({ data }) => normalize(data || {}),
  });

  function load() {
    return normalize(storage.load());
  }

  function save(data) {
    storage.save(normalize(data));
  }

  function erase() {
    storage.erase();
  }

  return Object.freeze({ load, save, erase });
}

module.exports = { createMemoryStore, SCHEMA_VERSION };
