const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const displaySettings = require('../src/services/display-settings');

test('display settings default, clamp, and persist bounded values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-display-'));
  const file = path.join(dir, 'display-settings.json');
  displaySettings.setRuntimePath(file);

  try {
    assert.deepEqual(displaySettings.getSettings(), { scale: 1, alwaysOnTop: true });
    assert.deepEqual(displaySettings.setSettings({ scale: 1.25, alwaysOnTop: false }), { scale: 1.25, alwaysOnTop: false });
    assert.deepEqual(displaySettings.getSettings(), { scale: 1.25, alwaysOnTop: false });
    assert.deepEqual(displaySettings.setSettings({ scale: 9 }), { scale: 1.5, alwaysOnTop: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { scale: 1.5, alwaysOnTop: false });
  } finally {
    displaySettings.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
