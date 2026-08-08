const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore, DEFAULTS } = require('../src/services/settings-store');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  return path.join(dir, 'settings.json');
}

test('defaults include layered-memory auto keys', () => {
  const store = createSettingsStore({ filePath: tmp() });
  const s = store.get();
  assert.equal(s.memoryAuto, true, 'auto judge on by default');
  assert.equal(s.memoryAutoInterval, 60000, 'default 60s interval');
  assert.equal(s.memorySoftDelete, true, 'soft delete on by default');
  assert.equal(s.networkConsent, false);
});

test('set/roundtrip persists auto-memory keys and strips unknown keys', () => {
  const file = tmp();
  const store = createSettingsStore({ filePath: file });
  store.set({ memoryAuto: false, memoryAutoInterval: 300000, memorySoftDelete: false, bogus: 123 });
  const s = store.get();
  assert.equal(s.memoryAuto, false);
  assert.equal(s.memoryAutoInterval, 300000);
  assert.equal(s.memorySoftDelete, false);
  assert.equal('bogus' in s, false, 'unknown keys stripped');
  // 重新加载仍保留
  const reloaded = createSettingsStore({ filePath: file }).get();
  assert.equal(reloaded.memoryAuto, false);
});

test('DEFAULTS is frozen and complete', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok('memoryAuto' in DEFAULTS && 'memoryAutoInterval' in DEFAULTS && 'memorySoftDelete' in DEFAULTS);
});
