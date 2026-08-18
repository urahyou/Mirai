const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const renderer = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', ...parts), 'utf8');

test('tool panels constrain and scroll long content rather than letting it expand past the footer', () => {
  const debug = renderer('debug-panel.css');
  const memory = renderer('memory-panel.css');
  const provider = renderer('provider-panel.css');

  assert.match(debug, /\.debug-shell\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(debug, /\.debug-detail\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/);
  assert.match(debug, /\.debug-content\s*\{[\s\S]*?flex:\s*1 1 0[\s\S]*?overflow-y:\s*scroll/);
  assert.match(memory, /\.reader-view\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(memory, /\.memory-detail\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow-y:\s*auto/);
  assert.match(provider, /\.provider-list\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('only the diary reader retains ruled paper styling', () => {
  const debug = renderer('debug-panel.css');
  const memory = renderer('memory-panel.css');

  assert.doesNotMatch(debug, /repeating-linear-gradient/);
  const memoryDetail = memory.slice(memory.indexOf('.memory-detail'), memory.indexOf('.tape'));
  assert.doesNotMatch(memoryDetail, /repeating-linear-gradient|linear-gradient/);
  const diary = memory.slice(memory.indexOf('.diary-page'), memory.indexOf('.memory-detail'));
  assert.match(diary, /repeating-linear-gradient/);
});
