const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const windowLayout = require('../src/services/window-layout');

test('window layout persists only finite chat offsets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-window-layout-'));
  const file = path.join(dir, 'window-layout.json');
  windowLayout.setRuntimePath(file);

  try {
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: null });
    assert.deepEqual(windowLayout.setLayout({ chatOffset: { x: -78.4, y: 156.6 } }), { chatOffset: { x: -78, y: 157 } });
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: { x: -78, y: 157 } });
    assert.deepEqual(windowLayout.setLayout({ chatOffset: { x: 'bad', y: 3 } }), { chatOffset: null });
  } finally {
    windowLayout.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
