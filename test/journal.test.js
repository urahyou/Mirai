const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const journal = require('../src/systems/journal');
const E = require('../src/contracts/events');

const DAY = 24 * 3600 * 1000;
let tmp, t;

function makeNow(ms) { return () => new Date(ms); }

test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  journal._reset();
  journal.init({ dir: tmp, petState: { describe: () => '心情：平静' } });
  t = 1786900000000; // 某天中午（固定基准）
});

test.afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('同一天事件累积到 buffer，不落盘', () => {
  journal._setNow(makeNow(t));
  journal.onEvent(E.PET.CONVERSATION);
  journal.onEvent(E.PET.GREETING);
  assert.strictEqual(journal._state().buffer.length, 2);
  assert.ok(!fs.existsSync(path.join(tmp, 'journals')));
});

test('日期切换时 close 上一页并开新页', () => {
  journal._setNow(makeNow(t));
  journal.onEvent(E.PET.CONVERSATION);
  journal._setNow(makeNow(t + DAY)); // 次日
  journal.onEvent(E.PET.GREETING);
  const d1 = dateStrFromMsg(t);
  const file = path.join(tmp, 'journals', `${d1}.md`);
  assert.ok(fs.existsSync(file), '应落盘前一天日记');
  assert.ok(fs.readFileSync(file, 'utf8').includes('聊了 1 次天'));
  // 新页已开，看到的是新一天
  assert.strictEqual(journal._state().buffer.length, 1);
  assert.strictEqual(journal._state().buffer[0].type, E.PET.GREETING);
});

test('flush 在退出时落盘当天（幂等）', () => {
  journal._setNow(makeNow(t));
  journal.onEvent(E.PET.CONVERSATION);
  const d1 = dateStrFromMsg(t);
  journal.flush();
  journal.flush(); // 幂等
  const file = path.join(tmp, 'journals', `${d1}.md`);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.readFileSync(file, 'utf8').includes('小未来日记'));
});

test('buffer 持久化：重启后同一天继续累积', () => {
  journal._setNow(makeNow(t));
  journal.onEvent(E.PET.CONVERSATION); // 已 saveState
  // 模拟重启
  journal._reset();
  journal.init({ dir: tmp, petState: { describe: () => '心情：平静' } });
  assert.strictEqual(journal._state().buffer.length, 1);
  journal.onEvent(E.PET.GREETING);
  assert.strictEqual(journal._state().buffer.length, 2);
});

test('eventBus 订阅自动记录', () => {
  const { createEventBus } = require('../src/services/event-bus');
  const bus = createEventBus();
  journal._reset();
  journal.init({ eventBus: bus, dir: tmp, petState: { describe: () => '' } });
  journal._setNow(makeNow(t));
  bus.emit(E.PET.CONVERSATION);
  bus.emit(E.PET.GREETING);
  assert.strictEqual(journal._state().buffer.length, 2);
});

// 从 buffer 时间戳反推日期（避免依赖边界混乱）
function dateStrFromMsg(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
