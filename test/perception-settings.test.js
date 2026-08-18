const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const storage = require('../src/services/storage');
const settings = require('../src/services/perception-settings');

let dir;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-perception-'));
  storage._reset(); storage.setRuntimeDir(dir); settings.init({ storage });
});
test.afterEach(() => {
  storage.setRuntimeDir(null); storage._reset(); fs.rmSync(dir, { recursive: true, force: true });
});

test('perception settings expose low-risk defaults and sensitive sources off', () => {
  assert.deepEqual(settings.listSources().map(({ id, enabled, sensitivity, ttlSeconds }) => ({ id, enabled, sensitivity, ttlSeconds })), [
    { id: 'system', enabled: true, sensitivity: 'low', ttlSeconds: 900 },
    { id: 'weather', enabled: false, sensitivity: 'low', ttlSeconds: 1800 },
    { id: 'screen', enabled: false, sensitivity: 'high', ttlSeconds: 300 },
  ]);
});

test('perception settings persist bounded patches and reject unknown sources', () => {
  const saved = settings.setSource('screen', { enabled: true, ttlSeconds: 999999 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.ttlSeconds, 86400);
  assert.equal(settings.getSource('screen').enabled, true);
  assert.throws(() => settings.setSource('camera', { enabled: true }), /未知/);
  assert.throws(() => settings.setSource('system', { enabled: 'yes' }), /布尔值/);
  assert.throws(() => settings.setSource('system', { command: 'whoami' }), /字段/);
});
