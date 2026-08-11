const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = Object.freeze({
  scale: 1,
  alwaysOnTop: true,
  outlineShadow: false,
});

const SCALE_MIN = 0.7;
const SCALE_MAX = 1.5;

let runtimePath = null;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const scale = Number(source.scale);
  return {
    scale: Number.isFinite(scale) ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale)) : DEFAULT_SETTINGS.scale,
    alwaysOnTop: typeof source.alwaysOnTop === 'boolean' ? source.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    outlineShadow: typeof source.outlineShadow === 'boolean' ? source.outlineShadow : DEFAULT_SETTINGS.outlineShadow,
  };
}

function getSettings() {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...(runtimePath ? readJson(runtimePath) : null),
  });
}

function setSettings(patch) {
  if (!runtimePath) throw new Error('display settings runtime path 未初始化');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('display settings patch 必须是对象');
  const next = normalizeSettings({ ...getSettings(), ...patch });
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify(next, null, 2));
  return next;
}

function setRuntimePath(filePath) {
  runtimePath = filePath || null;
}

module.exports = {
  DEFAULT_SETTINGS,
  SCALE_MIN,
  SCALE_MAX,
  getSettings,
  setSettings,
  setRuntimePath,
};
