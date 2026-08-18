const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createAgentActions = require('../src/services/agent-actions');

let directory;
test.beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-agent-actions-')); });
test.afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

test('draft action writes only inside the fixed userData draft directory', async () => {
  const actions = createAgentActions({ getUserData: () => directory });
  const result = await actions['draft.create']({ proposal: { parameters: { title: '问候', body: '你好，主人。' } } });
  assert.equal(result.summary, '本地草稿已创建');
  const draftDir = path.join(directory, 'agent-drafts');
  const files = fs.readdirSync(draftDir);
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(path.join(draftDir, files[0]), 'utf8'), /^# 问候\n\n你好，主人。\n$/);
  assert.equal(fs.statSync(path.join(draftDir, files[0])).mode & 0o077, 0);
});

test('draft action rejects path injection and symlink draft directories', async () => {
  const actions = createAgentActions({ getUserData: () => directory });
  await assert.rejects(actions['draft.create']({ proposal: { parameters: { title: 'x', body: 'y', path: '../escape.md' } } }), /字段/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-agent-outside-'));
  fs.symlinkSync(outside, path.join(directory, 'agent-drafts'));
  try {
    await assert.rejects(actions['draft.create']({ proposal: { parameters: { title: 'x', body: 'y' } } }), /符号链接/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
