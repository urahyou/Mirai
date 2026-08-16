const path = require('path');
const fs = require('fs');

// 内置出厂人格（只读，升级不覆盖）
const BASE_PERSONALITY_PATH = path.join(__dirname, '..', 'templates', 'personality.json');

// 运行时人格覆盖文件路径，由 main.js 在 app.whenReady 时注入 userData 路径
let runtimePath = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 深合并：普通对象逐键合并；数组/标量直接整体覆盖（用户改过的列表以用户为准）
function deepMerge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return clone(override);
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return clone(override);
  const out = {};
  for (const key of Object.keys(base)) out[key] = clone(base[key]);
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

function readRuntime() {
  if (!runtimePath) return {};
  const doc = readJson(runtimePath);
  return doc && typeof doc === 'object' ? doc : {};
}

function getPersonality() {
  const base = readJson(BASE_PERSONALITY_PATH);
  return deepMerge(base || {}, readRuntime());
}

function setPersonality(patch) {
  if (!runtimePath) throw new Error('personality runtime path 未初始化');
  if (!patch || typeof patch !== 'object') throw new TypeError('patch 必须是对象');
  const next = deepMerge(readRuntime(), patch);
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify(next, null, 2));
  return deepMerge(readJson(BASE_PERSONALITY_PATH) || {}, next);
}

function resetPersonality() {
  if (runtimePath) {
    try {
      fs.unlinkSync(runtimePath);
    } catch {
      /* 文件不存在视为已重置 */
    }
  }
  return getPersonality();
}

function setRuntimePath(filePath) {
  runtimePath = filePath || null;
}

function getRuntimePath() {
  return runtimePath;
}

module.exports = {
  getPersonality,
  setPersonality,
  resetPersonality,
  setRuntimePath,
  getRuntimePath,
  deepMerge,
};