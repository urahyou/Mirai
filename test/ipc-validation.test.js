const { test } = require('node:test');
const assert = require('node:assert');
const { validatePayload } = require('../src/main/ipc-validation');

// 防止「静默无反应」：所有记忆 IPC 通道必须通过 payload 校验，
// 否则 renderer 调用会拿到 IPC_ERROR，操作看似"点了没反应"。
test('memory update accepts status promotion/demotion (U3)', () => {
  assert.equal(validatePayload('memory:update', ['id-1', { status: 'core' }]).ok, true);
  assert.equal(validatePayload('memory:update', ['id-1', { status: 'active' }]).ok, true);
  assert.equal(validatePayload('memory:update', ['id-1', { status: 'bogus' }]).ok, false);
  assert.equal(validatePayload('memory:update', ['id-1', { status: 'core', content: 'x', importance: 0.5 }]).ok, true);
});

test('memory restore/purge/stats channels are registered and validate', () => {
  assert.equal(validatePayload('memory:restore', ['id-1']).ok, true);
  assert.equal(validatePayload('memory:restore', []).ok, false);
  assert.equal(validatePayload('memory:purge', ['id-1']).ok, true);
  assert.equal(validatePayload('memory:purge', ['id-1', 2]).ok, false);
  assert.equal(validatePayload('memory:stats', []).ok, true);
  assert.equal(validatePayload('memory:stats', [1]).ok, false);
});

test('memory list accepts layered filters including trashOnly', () => {
  assert.equal(validatePayload('memory:list', []).ok, true);
  assert.equal(validatePayload('memory:list', [{ includeArchived: true }]).ok, true);
  assert.equal(validatePayload('memory:list', [{ includeArchived: true, trashOnly: true }]).ok, true);
  // includeArchived 必须是布尔
  assert.equal(validatePayload('memory:list', [{ includeArchived: 'yes' }]).ok, false);
});

test('settings:set accepts new memory keys (memoryAuto/interval/softDelete) by type', () => {
  assert.equal(validatePayload('settings:set', [{ memoryAuto: false, memoryAutoInterval: 1800000, memorySoftDelete: true }]).ok, true);
  assert.equal(validatePayload('settings:set', [{ memoryAutoInterval: 'x' }]).ok, false);
  assert.equal(validatePayload('settings:set', [{ bogusKey: true }]).ok, false);
  // 老键仍兼容
  assert.equal(validatePayload('settings:set', [{ networkConsent: true }]).ok, true);
});
