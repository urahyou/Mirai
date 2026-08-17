// 主动行为的用户边界：静音、安静时段和每日预算与策略逻辑分开持久化。
const storageDefault = require('./storage');

const KEY = 'initiative-settings';
const DEFAULTS = Object.freeze({
  enabled: true,
  quietStartHour: 23,
  quietEndHour: 8,
  dailyBudget: 3,
  usageDate: '',
  usageCount: 0,
});

let storage = storageDefault;

function hour(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(23, Math.round(parsed))) : fallback;
}

function budget(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(12, Math.round(parsed))) : DEFAULTS.dailyBudget;
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const usageCount = Number(source.usageCount);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
    quietStartHour: hour(source.quietStartHour, DEFAULTS.quietStartHour),
    quietEndHour: hour(source.quietEndHour, DEFAULTS.quietEndHour),
    dailyBudget: budget(source.dailyBudget),
    usageDate: typeof source.usageDate === 'string' ? source.usageDate.slice(0, 10) : '',
    usageCount: Number.isFinite(usageCount) ? Math.max(0, Math.min(99, Math.round(usageCount))) : 0,
  };
}

function init({ storage: injectedStorage } = {}) {
  storage = injectedStorage || storageDefault;
  storage.register(KEY, { version: 1, defaults: DEFAULTS, migrations: {}, normalize });
}

function dateKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isQuiet(settings, now) {
  const start = settings.quietStartHour;
  const end = settings.quietEndHour;
  if (start === end) return false;
  const current = new Date(now).getHours();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function stateFor(now = Date.now()) {
  const state = storage.read(KEY);
  return state.usageDate === dateKey(now) ? state : { ...state, usageDate: dateKey(now), usageCount: 0 };
}

function getSettings() {
  const { usageDate, usageCount, ...publicSettings } = storage.read(KEY);
  return publicSettings;
}

function setSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('主动行为设置必须是对象');
  const current = storage.read(KEY);
  const next = storage.write(KEY, {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(patch, 'enabled') ? { enabled: patch.enabled } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'quietStartHour') ? { quietStartHour: patch.quietStartHour } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'quietEndHour') ? { quietEndHour: patch.quietEndHour } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'dailyBudget') ? { dailyBudget: patch.dailyBudget } : {}),
  });
  const { usageDate, usageCount, ...publicSettings } = next;
  return publicSettings;
}

function allows(now = Date.now()) {
  if (!Number.isFinite(now)) return false;
  const state = stateFor(now);
  return state.enabled && !isQuiet(state, now) && state.usageCount < state.dailyBudget;
}

function reserve(now = Date.now()) {
  if (!allows(now)) return false;
  const state = stateFor(now);
  storage.write(KEY, { ...state, usageCount: state.usageCount + 1 });
  return true;
}

module.exports = { KEY, DEFAULTS, init, getSettings, setSettings, allows, reserve, isQuiet, _normalize: normalize };
