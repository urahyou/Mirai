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
    assert.deepEqual(displaySettings.getSettings(), { scale: 1, alwaysOnTop: true, outlineShadow: false, bubbleDuration: 0, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 });
    assert.deepEqual(
      displaySettings.setSettings({ scale: 1.25, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 8 }),
      { scale: 1.25, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 8, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 },
    );
    assert.deepEqual(displaySettings.getSettings(), { scale: 1.25, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 8, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 });
    assert.deepEqual(displaySettings.setSettings({ scale: 9, bubbleDuration: 99 }), { scale: 1.5, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 30, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 });
    assert.deepEqual(displaySettings.setSettings({ bubbleDuration: 0 }), { scale: 1.5, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 0, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 });
    assert.deepEqual(displaySettings.setSettings({ voiceDockAutoHide: false, voiceDockAutoHideSec: 99 }), { scale: 1.5, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 0, voiceDockAutoHide: false, voiceDockAutoHideSec: 30 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { scale: 1.5, alwaysOnTop: false, outlineShadow: true, bubbleDuration: 0, voiceDockAutoHide: false, voiceDockAutoHideSec: 30 });
  } finally {
    displaySettings.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
