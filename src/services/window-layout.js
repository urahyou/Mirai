const path = require('path');
const fs = require('fs');

const DEFAULT_LAYOUT = Object.freeze({
  chatOffset: null,
});

let runtimePath = null;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeOffset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function getLayout() {
  const source = runtimePath ? readJson(runtimePath) : null;
  return {
    chatOffset: normalizeOffset(source?.chatOffset),
  };
}

function setLayout(patch) {
  if (!runtimePath) throw new Error('window layout runtime path 未初始化');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('window layout patch 必须是对象');
  const next = {
    ...getLayout(),
    ...(Object.prototype.hasOwnProperty.call(patch, 'chatOffset')
      ? { chatOffset: normalizeOffset(patch.chatOffset) }
      : {}),
  };
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify(next, null, 2));
  return next;
}

function setRuntimePath(filePath) {
  runtimePath = filePath || null;
}

module.exports = { DEFAULT_LAYOUT, getLayout, setLayout, setRuntimePath };
