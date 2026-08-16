// 上下文设置：控制“喂给大模型的对话历史 token 预算”。
// 持久化到 userData/context-settings.json。
// 滑条上限 = 探测到的模型最大上下文；滑条值 = 我们实际发送的上下文 token 预算。

const fs = require('fs');
const path = require('path');

// 默认/范围。maxContextTokens 表示发送给模型的对话历史 token 预算（单位：1000 tokens）。
// 用“千 token”作为滑条粒度，避免过大的数值。
const DEFAULT_MAX_CONTEXT_TOKENS = 4096; // 默认 4k，保守、省 token。
const MIN_CONTEXT_TOKENS = 1000; // 至少 1k，保证有可用的短对话。
const SOFT_MAX_CONTEXT_TOKENS = 131072; // 滑条软上限 128k；若探测到更大的模型上限则用其上限。

let runtimePath = null;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONTEXT_TOKENS;
  return Math.max(min, Math.min(max, n));
}

function normalizeSettings(raw, modelMaxTokens) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const upper = getUpperBound(modelMaxTokens);
  return {
    maxContextTokens: clampInt(source.maxContextTokens, MIN_CONTEXT_TOKENS, upper),
    modelMaxTokens: Number.isFinite(modelMaxTokens)
      ? Math.round(modelMaxTokens)
      : null,
  };
}

// 滑条上限：探测到模型上限则用它，否则用软上限。
function getUpperBound(modelMaxTokens) {
  const m = Number(modelMaxTokens);
  if (Number.isFinite(m) && m > 0) return Math.max(m, MIN_CONTEXT_TOKENS);
  return SOFT_MAX_CONTEXT_TOKENS;
}

function getSettings(modelMaxTokens) {
  return normalizeSettings({
    ...{ maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS },
    ...(runtimePath ? readJson(runtimePath) : null),
  }, modelMaxTokens);
}

function setSettings(patch, modelMaxTokens) {
  if (!runtimePath) throw new Error('context settings runtime path 未初始化');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('context settings patch 必须是对象');
  const next = normalizeSettings({ ...getSettings(modelMaxTokens), ...patch }, modelMaxTokens);
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify(next, null, 2));
  return next;
}

function setRuntimePath(filePath) {
  runtimePath = filePath || null;
}

module.exports = {
  DEFAULT_MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  SOFT_MAX_CONTEXT_TOKENS,
  getSettings,
  setSettings,
  setRuntimePath,
  getUpperBound,
};
