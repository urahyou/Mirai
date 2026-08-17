const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const storage = require('../src/services/storage');
const initiative = require('../src/services/initiative-settings');

let dir;
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-initiative-'));
  storage._reset(); storage.setRuntimeDir(dir); initiative.init({ storage });
}
function teardown() { storage.setRuntimeDir(null); storage._reset(); fs.rmSync(dir, { recursive: true, force: true }); }
function localTime(hour) { const date = new Date(2026, 7, 17, hour, 0, 0, 0); return date.getTime(); }

test('主动设置会持久化，并在跨午夜安静时段阻止发言', () => {
  setup();
  try {
    assert.deepEqual(initiative.getSettings(), { enabled: true, quietStartHour: 23, quietEndHour: 8, dailyBudget: 3 });
    initiative.setSettings({ quietStartHour: 22, quietEndHour: 7, dailyBudget: 1 });
    assert.equal(initiative.allows(localTime(23)), false);
    assert.equal(initiative.allows(localTime(9)), true);
    assert.equal(initiative.reserve(localTime(9)), true);
    assert.equal(initiative.allows(localTime(9)), false);
    assert.deepEqual(initiative.getSettings(), { enabled: true, quietStartHour: 22, quietEndHour: 7, dailyBudget: 1 });
  } finally { teardown(); }
});
