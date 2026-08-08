const { createJsonStorage } = require('./json-storage');

const SCHEMA_VERSION = 1;
const DEFAULTS = Object.freeze({
  enabled: false,
  pausedUntil: null,
  quietHours: { allow: [[0, 24 * 60]] },
  hourlyBudget: 1,
  dailyBudget: 3,
  cooldownMinutes: 60,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validMinute(value) {
  return Number.isInteger(value) && value >= 0 && value <= 24 * 60;
}

function normalizeQuietHours(value) {
  const quietHours = value && typeof value === 'object' ? value : {};
  const allow = Array.isArray(quietHours.allow)
    ? quietHours.allow.filter((period) => Array.isArray(period) && period.length === 2 && validMinute(period[0]) && validMinute(period[1]))
    : [];
  const normalized = { allow: allow.length ? allow.map(([start, end]) => [start, end]) : clone(DEFAULTS.quietHours.allow) };
  if (Array.isArray(quietHours.weekdays)) {
    const weekdays = quietHours.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
    if (weekdays.length) normalized.weekdays = [...new Set(weekdays)];
  }
  return normalized;
}

function normalizeSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  const pausedAt = settings.pausedUntil == null ? null : new Date(settings.pausedUntil);
  return {
    enabled: settings.enabled === true,
    pausedUntil: pausedAt && !Number.isNaN(pausedAt.getTime()) ? pausedAt.toISOString() : null,
    quietHours: normalizeQuietHours(settings.quietHours),
    hourlyBudget: Number.isInteger(settings.hourlyBudget) && settings.hourlyBudget >= 0 ? settings.hourlyBudget : DEFAULTS.hourlyBudget,
    dailyBudget: Number.isInteger(settings.dailyBudget) && settings.dailyBudget >= 0 ? settings.dailyBudget : DEFAULTS.dailyBudget,
    cooldownMinutes: Number.isInteger(settings.cooldownMinutes) && settings.cooldownMinutes >= 0 ? settings.cooldownMinutes : DEFAULTS.cooldownMinutes,
  };
}

function createProactiveSettingsStore({ filePath }) {
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
    const next = normalizeSettings({ ...get(), ...settings });
    storage.save(next);
    return next;
  }

  function eraseAll() {
    storage.erase();
  }

  return Object.freeze({ get, set, eraseAll });
}

module.exports = { createProactiveSettingsStore, DEFAULTS };
