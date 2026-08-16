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
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: null, mainPosition: null });
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: null, mainPosition: null });
    // chatOffset 持久化与整型取整
    assert.deepEqual(windowLayout.setLayout({ chatOffset: { x: -78.4, y: 156.6 } }), { chatOffset: { x: -78, y: 157 }, mainPosition: null });
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: { x: -78, y: 157 }, mainPosition: null });
    // 非有限值归一为 null
    assert.deepEqual(windowLayout.setLayout({ chatOffset: { x: 'bad', y: 3 } }), { chatOffset: null, mainPosition: null });
  } finally {
    windowLayout.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('window layout persists mainPosition (跨重启角色位置记忆)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-window-layout-'));
  const file = path.join(dir, 'window-layout.json');
  windowLayout.setRuntimePath(file);

  try {
    // 初始为 null
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: null, mainPosition: null });
    // 写入位置
    assert.deepEqual(
      windowLayout.setLayout({ mainPosition: { x: 320.6, y: 240.4 } }),
      { chatOffset: null, mainPosition: { x: 321, y: 240 } },
    );
    // 与 chatOffset 并存互不影响
    windowLayout.setLayout({ chatOffset: { x: -10, y: 20 } });
    assert.deepEqual(windowLayout.getLayout(), { chatOffset: { x: -10, y: 20 }, mainPosition: { x: 321, y: 240 } });
    // 非法值归一为 null
    assert.deepEqual(windowLayout.setLayout({ mainPosition: { x: 'nope', y: 5 } }), { chatOffset: { x: -10, y: 20 }, mainPosition: null });
  } finally {
    windowLayout.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
