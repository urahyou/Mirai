const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { IPC_ERROR, validatePayload } = require('../src/main/ipc-validation');

function assertRejected(channel, args) {
  assert.deepEqual(validatePayload(channel, args), IPC_ERROR);
}

test('Given bounded settings and memory payloads When validation receives valid data Then it returns normalized arguments', () => {
  assert.deepEqual(validatePayload('settings:set', [{ notifications: true, sound: false, animation: true, reduceMotion: false, networkConsent: false, memorySaving: true }]), {
    ok: true,
    data: [{ notifications: true, sound: false, animation: true, reduceMotion: false, networkConsent: false, memorySaving: true }],
  });
  assert.deepEqual(validatePayload('proactive:setSettings', [{ enabled: true, quietHours: { allow: [[0, 480]], weekdays: [1, 2] } }]), {
    ok: true,
    data: [{ enabled: true, quietHours: { allow: [[0, 480]], weekdays: [1, 2] } }],
  });
  assert.deepEqual(validatePayload('memory:update', ['memory-1', { type: 'preference', content: 'Tea after lunch', importance: 0.8 }]), {
    ok: true,
    data: ['memory-1', { type: 'preference', content: 'Tea after lunch', importance: 0.8 }],
  });
  assert.deepEqual(validatePayload('memory:doNotRemember', [{ type: 'profile', content: 'Do not retain this note' }]), {
    ok: true,
    data: [{ type: 'profile', content: 'Do not retain this note' }],
  });
  // 面板 list() 无参调用 → preload 转发 undefined 作为位置参数，应视同「不过滤」
  assert.deepEqual(validatePayload('memory:list', [undefined]), { ok: true, data: [] });
  assert.deepEqual(validatePayload('memory:list', [null]), { ok: true, data: [] });
  assert.deepEqual(validatePayload('schedule:list', [undefined]), { ok: true, data: [] });
  assert.deepEqual(validatePayload('owner:set', [{ name: '小明', birthday: '8月24', likes: ['甜食', '猫'], note: '常来陪我' }]), {
    ok: true,
    data: [{ name: '小明', birthday: '8月24', likes: ['甜食', '猫'], note: '常来陪我' }],
  });
  assert.deepEqual(validatePayload('personality:set', [{ name: '小暖', personality: { mood: '元気', likes: ['团子'], tone: '俏皮', selfIntro: 'test' } }]), {
    ok: true,
    data: [{ name: '小暖', personality: { mood: '元気', likes: ['团子'], tone: '俏皮', selfIntro: 'test' } }],
  });
  assert.deepEqual(validatePayload('proactive:setSettings', [{ quietHours: { allow: [[22 * 60, 6 * 60]] } }]), {
    ok: true,
    data: [{ quietHours: { allow: [[22 * 60, 6 * 60]] } }],
  });
});

test('Given malformed, oversized, enum-invalid, or unrelated IPC payloads When validation runs Then every rejection uses the uniform error', () => {
  assertRejected('settings:set', [null]);
  assertRejected('settings:set', [{ notifications: 'yes' }]);
  assertRejected('proactive:setSettings', [{ quietHours: { allow: [[0, 1441]] } }]);
  assertRejected('proactive:pause', ['not-a-date']);
  assertRejected('memory:list', [{ includeArchived: 'true' }]);
  assertRejected('memory:remember', [{ type: 'unknown', content: 'note', explicit: true }]);
  assertRejected('memory:remember', [{ type: 'profile', content: 'x'.repeat(1001), explicit: true }]);
  assertRejected('memory:update', [42, { content: 'note' }]);
  assertRejected('memory:update', ['memory-1', { type: 'unknown' }]);
  assertRejected('memory:remove', ['x'.repeat(129)]);
  assertRejected('memory:forget', [{}]);
  assertRejected('memory:doNotRemember', [{ type: 'profile', content: 42 }]);
  assertRejected('memory:export', [{}]);
  assertRejected('memory:clearAll', ['unexpected']);
  assertRejected('schedule:create', [{ title: 'missing time' }]);
  assertRejected('schedule:create', [{ title: 'invalid time', runAt: 'not-a-date' }]);
  assertRejected('owner:set', [{ name: 'x'.repeat(41) }]);
  assertRejected('owner:set', [{ likes: [42] }]);
  assertRejected('personality:set', [{ personality: { likes: ['ok', 42] } }]);
  assertRejected('personality:set', [{ personality: { tone: 'x'.repeat(1001) } }]);
  assertRejected('tool:execute', [{ command: 'whoami' }]);
});

test('Given the preload bridge When its public surface is inspected Then it exposes no tool-execution or Node capability', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');

  assert.doesNotMatch(preload, /\b(tool|execute|exec|spawn|child_process|require\(['"](?:fs|node:fs|child_process))/i);
  assert.match(preload, /memory:\s*Object\.freeze/);
});
