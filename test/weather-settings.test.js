const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const storage = require('../src/services/storage');
const weather = require('../src/services/weather-settings');

let dir;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-weather-'));
  storage._reset(); storage.setRuntimeDir(dir); weather.init({ storage });
});
test.afterEach(() => {
  storage.setRuntimeDir(null); storage._reset(); fs.rmSync(dir, { recursive: true, force: true });
});

test('weather settings stay unconfigured until valid local coordinates are saved', () => {
  assert.deepEqual(weather.getSettings(), { latitude: null, longitude: null });
  assert.equal(weather.isConfigured(), false);
  assert.deepEqual(weather.setSettings({ latitude: 31.2304, longitude: 121.4737 }), { latitude: 31.2304, longitude: 121.4737 });
  assert.equal(weather.isConfigured(), true);
  assert.deepEqual(weather.setSettings({ latitude: null, longitude: null }), { latitude: null, longitude: null });
  assert.equal(weather.isConfigured(), false);
});

test('weather settings clamp malformed coordinates to no location', () => {
  weather.setSettings({ latitude: 999, longitude: -999 });
  assert.deepEqual(weather.getSettings(), { latitude: null, longitude: null });
  assert.throws(() => weather.setSettings({ city: 'Shanghai' }), /字段/);
});
