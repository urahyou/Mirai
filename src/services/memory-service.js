const crypto = require('node:crypto');

const MEMORY_TYPES = Object.freeze(['profile', 'preference', 'episodic', 'relationship', 'work', 'schedule']);
const PROMPT_ALLOWED_TYPES = Object.freeze(['profile', 'preference', 'relationship', 'work', 'schedule']);
const MAX_RESULTS = 12;
const MAX_PROMPT_CHARS = 1200;
const FORBIDDEN_CONTENT = /\b(?:api[ _-]?key|password|passphrase|secret|access[ _-]?token|authorization|bearer|health|medical|diagnos(?:e|is)|illness|disease)\b|症状|疾病|健康状况|病历/i;
const FORBIDDEN_FIELD = /api[ _-]?key|password|passphrase|secret|token|authorization|health|medical/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function validType(value) {
  return MEMORY_TYPES.includes(value);
}

function validScore(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function validDate(value, fallback) {
  if (value == null) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function containsForbiddenField(candidate) {
  return candidate && typeof candidate === 'object'
    && Object.keys(candidate).some((key) => FORBIDDEN_FIELD.test(key));
}

function hasForbiddenContent(content) {
  return FORBIDDEN_CONTENT.test(content);
}

function fingerprint(type, content) {
  return crypto.createHash('sha256').update(`${type}\u0000${normalizedText(content).toLowerCase()}`).digest('hex');
}

function keywordMatches(content, query) {
  const keywords = normalizedText(query).toLowerCase().split(/\s+/).filter(Boolean);
  return keywords.length === 0 || keywords.every((keyword) => content.toLowerCase().includes(keyword));
}

function active(memory, now) {
  return !memory.archivedAt && !memory.deletedAt && memory.status !== 'compressed' && !memory.compressed
    && (!memory.expiresAt || memory.expiresAt > now.toISOString());
}

function compareMemories(left, right) {
  if (right.importance !== left.importance) return right.importance - left.importance;
  if (right.lastAccessedAt !== left.lastAccessedAt) return right.lastAccessedAt.localeCompare(left.lastAccessedAt);
  return left.id.localeCompare(right.id);
}

function createMemoryService(storage, options = {}) {
  if (!storage || typeof storage.load !== 'function' || typeof storage.save !== 'function' || typeof storage.erase !== 'function') {
    throw new TypeError('storage must provide load, save, and erase functions');
  }

  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const createId = typeof options.createId === 'function' ? options.createId : crypto.randomUUID;

  function readDocument() {
    const value = storage.load();
    return value && typeof value === 'object' && Array.isArray(value.memories)
      ? { memories: value.memories, blocked: Array.isArray(value.blocked) ? value.blocked : [] }
      : { memories: [], blocked: [] };
  }

  function writeDocument(document) {
    storage.save({ memories: document.memories, blocked: document.blocked });
  }

  function remember(candidate) {
    const input = candidate && typeof candidate === 'object' ? candidate : {};
    const content = normalizedText(input.content);
    const source = typeof input.source === 'string' && input.source ? input.source : 'user';
    const explicit = input.explicit === true;
    const importance = validScore(input.importance, explicit ? 0.7 : 0);
    const confidence = validScore(input.confidence, explicit ? 1 : 0);
    if (!validType(input.type) || !content || containsForbiddenField(input) || hasForbiddenContent(content) || hasForbiddenContent(source)) return null;
    if (!explicit && (importance < 0.8 || confidence < 0.9)) return null;

    const document = readDocument();
    if (document.blocked.includes(fingerprint(input.type, content))) return null;
    const now = clock().toISOString();
    const memory = {
      id: createId(),
      type: input.type,
      content,
      importance,
      confidence,
      source,
      sensitivity: 'standard',
      createdAt: validDate(input.createdAt, now),
      lastAccessedAt: now,
      expiresAt: validDate(input.expiresAt, null),
      // 方案 C 分层：status=core 常驻画像；weight 热度分；accessCount 检索次数；
      // 其余（subEntryIds/isSummary/conflictWith）为反思压缩与冲突预留，默认空。
      status: input.status === 'core' ? 'core' : 'active',
      weight: importance,
      accessCount: 0,
      isSummary: false,
      subEntryIds: Array.isArray(input.subEntryIds) ? input.subEntryIds : [],
      conflictWith: Array.isArray(input.conflictWith) ? input.conflictWith : [],
    };
    writeDocument({ ...document, memories: [...document.memories.filter((item) => item.id !== memory.id), memory] });
    return clone(memory);
  }

  function list({ includeArchived = false, trashOnly = false } = {}) {
    const now = clock();
    return readDocument().memories
      .filter((memory) => trashOnly ? !!memory.deletedAt : !memory.deletedAt && (includeArchived || active(memory, now)))
      .sort(compareMemories)
      .map(clone);
  }

  function retrieve({ query = '', types, limit = MAX_RESULTS } = {}) {
    const allowedTypes = Array.isArray(types) ? types.filter(validType) : MEMORY_TYPES;
    const now = clock();
    const selected = readDocument().memories
      .filter((memory) => active(memory, now) && allowedTypes.includes(memory.type) && keywordMatches(memory.content, query))
      .sort(compareMemories)
      .slice(0, Math.max(0, Math.min(MAX_RESULTS, Number.isInteger(limit) ? limit : MAX_RESULTS)));
    if (selected.length === 0) return [];

    const accessedAt = now.toISOString();
    const selectedIds = new Set(selected.map((memory) => memory.id));
    const document = readDocument();
    writeDocument({
      ...document,
      memories: document.memories.map((memory) => selectedIds.has(memory.id) ? { ...memory, lastAccessedAt: accessedAt } : memory),
    });
    return selected.map((memory) => ({ ...memory, lastAccessedAt: accessedAt }));
  }

  function getPromptMemories({ query = '', networkAllowed = false, maxChars = MAX_PROMPT_CHARS } = {}) {
    if (networkAllowed !== true) return [];
    const budget = Math.max(0, Math.min(MAX_PROMPT_CHARS, Number.isInteger(maxChars) ? maxChars : MAX_PROMPT_CHARS));
    let used = 0;
    return retrieve({ query, types: PROMPT_ALLOWED_TYPES }).filter((memory) => {
      if (used + memory.content.length > budget) return false;
      used += memory.content.length;
      return true;
    });
  }

  function buildPromptContext(options) {
    const maxChars = options && Number.isInteger(options.maxChars)
      ? Math.max(0, Math.min(MAX_PROMPT_CHARS, options.maxChars))
      : MAX_PROMPT_CHARS;
    let used = 0;
    return getPromptMemories(options).reduce((lines, memory) => {
      const line = `[${memory.type}] ${memory.content}`;
      if (used + line.length > maxChars) return lines;
      used += line.length;
      lines.push(line);
      return lines;
    }, []).join('\n');
  }

  // 方案 C：Core 常驻画像（status=core 的极小段，随字符预算裁剪）。
  // 未授权网络记忆时返回空，与既有安全行为一致。
  function coreMemories({ maxChars = 800 } = {}) {
    const now = clock();
    const budget = Math.max(0, Math.min(800, Number.isInteger(maxChars) ? maxChars : 800));
    let used = 0;
    return readDocument().memories
      .filter((memory) => active(memory, now) && memory.status === 'core')
      .sort(compareMemories)
      .filter((memory) => {
        const line = `[${memory.type}] ${memory.content}`;
        if (used + line.length > budget) return false;
        used += line.length;
        return true;
      })
      .map((memory) => `[${memory.type}] ${memory.content}`)
      .join('\n');
  }

  // 方案 C：分层注入上下文。返回 { core, working } 两段，分别供常驻与动态检索注入。
  // networkAllowed 同时门控两端（隐私与既有 networkConsent 约定一致）。
  function buildLayeredContext({ query = '', networkAllowed = false, coreMaxChars = 800, workingMaxChars = 1200 } = {}) {
    const core = networkAllowed ? coreMemories({ maxChars: coreMaxChars }) : '';
    const working = networkAllowed ? buildPromptContext({ query, networkAllowed: true, maxChars: workingMaxChars }) : '';
    return { core, working };
  }

  function update(id, changes) {
    const document = readDocument();
    const existing = document.memories.find((memory) => memory.id === id);
    if (!existing || !changes || typeof changes !== 'object' || containsForbiddenField(changes)) return null;
    const candidate = { ...existing, ...changes, id: existing.id, explicit: true };
    const content = normalizedText(candidate.content);
    const source = typeof candidate.source === 'string' && candidate.source ? candidate.source : existing.source;
    if (!validType(candidate.type) || !content || hasForbiddenContent(content) || hasForbiddenContent(source)) return null;
    const updated = {
      ...existing,
      type: candidate.type,
      content,
      importance: validScore(candidate.importance, existing.importance),
      confidence: validScore(candidate.confidence, existing.confidence),
      source,
      sensitivity: 'standard',
      expiresAt: validDate(candidate.expiresAt, null),
      status: candidate.status === 'core' ? 'core' : 'active',
    };
    writeDocument({ ...document, memories: document.memories.map((memory) => memory.id === id ? updated : memory) });
    return clone(updated);
  }

  function remove(id) {
    const document = readDocument();
    const target = document.memories.find((m) => m.id === id);
    if (!target || target.deletedAt) return false;
    const deletedAt = clock().toISOString();
    writeDocument({ ...document, memories: document.memories.map((m) => m.id === id ? { ...m, deletedAt } : m) });
    return true;
  }

  // 软删 → 回收站还原（清 deletedAt 并回到活跃）
  function restore(id) {
    const document = readDocument();
    const memory = document.memories.find((m) => m.id === id);
    if (!memory || !memory.deletedAt) return null;
    const restored = { ...memory, deletedAt: null, archivedAt: null };
    writeDocument({ ...document, memories: document.memories.map((m) => m.id === id ? restored : m) });
    return clone(restored);
  }

  // 回收站内彻底删除（真正 erase）
  function purge(id) {
    const document = readDocument();
    const memories = document.memories.filter((m) => m.id !== id);
    if (memories.length === document.memories.length) return false;
    writeDocument({ ...document, memories });
    return true;
  }

  function forget({ id, type, content } = {}) {
    if (typeof id === 'string') return remove(id);
    if (!validType(type) || !normalizedText(content)) return false;
    const target = fingerprint(type, content);
    const now = clock().toISOString();
    const document = readDocument();
    let touched = false;
    writeDocument({ ...document, memories: document.memories.map((m) => {
      if (!m.deletedAt && fingerprint(m.type, m.content) === target) { touched = true; return { ...m, deletedAt: now }; }
      return m;
    }) });
    return touched;
  }

  // 记忆卫生：扫描出“值得处理”的记忆，返回清理建议（只建议，绝不自动删除）。
  // 对齐方案 C 保守原则：宁可保留，不误删。
  function hygiene({ daysUnused = 30, refNow } = {}) {
    const clockNow = refNow ? new Date(refNow) : clock();
    const mems = readDocument().memories.filter((m) => !m.deletedAt);
    const suggestions = [];
    const push = (id, tag, level, extra) => suggestions.push({ id, tag, level, ...(extra || {}) });
    for (const m of mems) {
      if (m.expiresAt && m.expiresAt <= clockNow.toISOString()) {
        push(m.id, 'expired', 'auto');
      } else if ((m.importance < 0.25 || m.confidence < 0.5) && m.accessCount === 0) {
        push(m.id, 'lowValue', 'suggest');
      } else if (m.accessCount === 0 && (clockNow.getTime() - new Date(m.createdAt).getTime() > daysUnused * 86400000)) {
        push(m.id, 'unused', 'suggest');
      }
    }
    // 疑似重复（fingerprint 相同，保留前者）
    const seen = new Map();
    for (const m of mems) {
      const fp = fingerprint(m.type, m.content);
      if (seen.has(fp)) push(m.id, 'duplicate', 'suggest');
      else seen.set(fp, m.id);
    }
    // legacy 旧数据（非 judge / user 来源的旧样式条目）
    for (const m of mems) {
      if (m.source && m.source !== 'judge' && m.source !== 'user') push(m.id, 'legacy', 'info', { source: m.source });
    }
    return suggestions;
  }

  function doNotRemember({ type, content } = {}) {
    if (!validType(type) || !normalizedText(content) || hasForbiddenContent(content)) return false;
    const document = readDocument();
    const target = fingerprint(type, content);
    writeDocument({ ...document, blocked: [...new Set([...document.blocked, target])] });
    return true;
  }

  function blocked() {
    return clone(readDocument().blocked);
  }

  // 反思压缩落点：把若干原始条标为 compressed，并写入 1 条摘要（isSummary+subEntryIds 可溯源）。
  // 保护：core / summary / 已删 的条不压；至少成功压 1 条才返回摘要。
  function reflect({ ids = [], content, type, importance = 0.5, confidence = 0.8, source = 'reflection' } = {}) {
    if (!Array.isArray(ids) || !ids.length) return null;
    const text = normalizedText(content);
    if (!text || !validType(type)) return null;
    const document = readDocument();
    const compressible = document.memories
      .filter((m) => ids.includes(m.id))
      .filter((m) => !m.deletedAt && !m.isSummary && m.status !== 'core' && m.status !== 'compressed');
    if (compressible.length === 0) return null;
    const compressIds = compressible.map((m) => m.id);
    const key = new Set(compressIds);
    const now = clock().toISOString();
    const memories = document.memories.map((m) => key.has(m.id) ? { ...m, status: 'compressed' } : m);
    const summary = {
      id: createId(),
      type,
      content: text,
      importance: validScore(importance, 0.5),
      confidence: validScore(confidence, 0.8),
      source,
      sensitivity: 'standard',
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: null,
      status: 'active',
      weight: validScore(importance, 0.5),
      accessCount: 0,
      isSummary: true,
      subEntryIds: compressIds.slice(),
      conflictWith: [],
    };
    writeDocument({ ...document, memories: [...memories.filter((m) => m.id !== summary.id), summary] });
    return clone(summary);
  }

  function archiveExpired() {
    const now = clock().toISOString();
    const document = readDocument();
    const memories = document.memories.map((memory) => !memory.archivedAt && memory.expiresAt && memory.expiresAt <= now
      ? { ...memory, archivedAt: now }
      : memory);
    writeDocument({ ...document, memories });
    return memories.filter((memory) => memory.archivedAt === now).map(clone);
  }

  function archive(id) {
    const document = readDocument();
    const archivedAt = clock().toISOString();
    const memory = document.memories.find((item) => item.id === id);
    if (!memory || memory.archivedAt) return null;
    const archived = { ...memory, archivedAt };
    writeDocument({ ...document, memories: document.memories.map((item) => item.id === id ? archived : item) });
    return clone(archived);
  }

  return Object.freeze({
    read() {
      return storage.load();
    },
    eraseAll() {
      storage.erase();
    },
    remember,
    list,
    retrieve,
    getPromptMemories,
    buildPromptContext,
    coreMemories,
    buildLayeredContext,
    update,
    remove,
    restore,
    purge,
    forget,
    hygiene,
    blocked,
    reflect,
    doNotRemember,
    archive,
    archiveExpired,
    exportData() {
      const doc = readDocument();
      return { schemaVersion: 1, exportedAt: clock().toISOString(), data: { memories: doc.memories.filter((m) => !m.deletedAt), blocked: doc.blocked } };
    },
    clearAll() {
      storage.erase();
    },
  });
}

module.exports = { createMemoryService, MEMORY_TYPES, PROMPT_ALLOWED_TYPES, MAX_PROMPT_CHARS };
