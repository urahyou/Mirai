const storageDefault = require('./storage');

const KEY = 'weather-settings';
const DEFAULTS = Object.freeze({ latitude: null, longitude: null });
let storage = storageDefault;

function coordinate(value, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? Math.round(parsed * 10000) / 10000
    : null;
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    latitude: coordinate(source.latitude, -90, 90),
    longitude: coordinate(source.longitude, -180, 180),
  };
}

function init({ storage: injectedStorage } = {}) {
  storage = injectedStorage || storageDefault;
  storage.register(KEY, { version: 1, defaults: DEFAULTS, migrations: {}, normalize });
}

function getSettings() { return storage.read(KEY); }

function setSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('天气位置必须是对象');
  if (!Object.keys(patch).every((key) => key === 'latitude' || key === 'longitude')) throw new TypeError('天气位置字段不合法');
  const current = storage.read(KEY);
  const next = {
    ...current,
    ...(Object.hasOwn(patch, 'latitude') ? { latitude: patch.latitude === null ? null : coordinate(patch.latitude, -90, 90) } : {}),
    ...(Object.hasOwn(patch, 'longitude') ? { longitude: patch.longitude === null ? null : coordinate(patch.longitude, -180, 180) } : {}),
  };
  storage.write(KEY, next);
  return getSettings();
}

function isConfigured() {
  const { latitude, longitude } = getSettings();
  return latitude !== null && longitude !== null;
}

module.exports = { KEY, DEFAULTS, init, getSettings, setSettings, isConfigured, _normalize: normalize };
