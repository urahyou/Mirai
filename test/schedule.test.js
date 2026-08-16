const test = require('node:test');
const assert = require('node:assert');
const sch = require('../src/systems/schedule');

test.beforeEach(() => sch._reset());

function icsLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function baseIcs(dstart, extra = '') {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:EVT1`,
    `DTSTART:${dstart}`,
    'SUMMARY:周会',
    'LOCATION:线上',
    extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('parseIcs 解析单次事件', () => {
  const d = new Date(2026, 7, 17, 10, 30);
  const evs = sch.parseIcs(baseIcs(icsLocal(d)));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].summary, '周会');
  assert.strictEqual(evs[0].location, '线上');
  assert.strictEqual(evs[0].uid, 'EVT1');
  assert.strictEqual(evs[0].startMs, d.getTime());
});

test('parseDateTime 支持 UTC(Z) 与本地', () => {
  assert.strictEqual(sch.parseDateTime('20260815T090000Z'), Date.UTC(2026, 7, 15, 9, 0, 0));
  assert.strictEqual(sch.parseDateTime('DTSTART;TZID=Asia/Shanghai:20260815T090000'), new Date(2026, 7, 15, 9, 0, 0).getTime());
});

test('nextOccurrence 单次与 DAILY 递推', () => {
  const base = new Date(2026, 7, 15, 9, 0).getTime();
  const evSingle = { startMs: base, rrule: null };
  assert.strictEqual(sch.nextOccurrence(evSingle, base - 1000), base);
  assert.strictEqual(sch.nextOccurrence(evSingle, base + 1000), null);

  // 每天 9:00，INTERVAL=1
  const evDaily = { startMs: base, rrule: { freq: 'DAILY', interval: 1, until: null } };
  const next = sch.nextOccurrence(evDaily, base + 4 * 24 * 3600 * 1000); // 4 天后
  assert.strictEqual(next, base + 4 * 24 * 3600 * 1000); // 下次是 base+4 天
});

test('checkReminders 临窗内触发、去重、超窗不触', async () => {
  const now = new Date(2026, 7, 17, 9, 55).getTime(); // 9:55
  const evStart = new Date(2026, 7, 17, 10, 0).getTime(); // 10:00，5 分钟后
  sch.init({ now: () => now, ics: () => baseIcs(icsLocal(new Date(evStart))), onEmit: () => {} });
  // 首个检查触发
  const fired1 = sch.checkReminders(now);
  assert.strictEqual(fired1.length, 1);
  assert.ok(fired1[0].includes('10:00'), fired1[0]);
  assert.ok(fired1[0].includes('周会'), fired1[0]);
  // 同一时刻再去重 → 不重复
  assert.strictEqual(sch.checkReminders(now).length, 0);
});

test('超出 lead 窗口（过早）不触发', () => {
  const now = new Date(2026, 7, 17, 9, 30).getTime();
  const evStart = new Date(2026, 7, 17, 10, 0).getTime(); // 30 分钟后 > 10min lead
  sch.init({ now: () => now, ics: () => baseIcs(icsLocal(new Date(evStart))) });
  assert.strictEqual(sch.checkReminders(now).length, 0);
});

test('tick 通过 onEmit 发出提醒；无 .ics 则静默', () => {
  const now = new Date(2026, 7, 17, 9, 55).getTime();
  const evStart = new Date(2026, 7, 17, 10, 0).getTime();
  const fired = [];
  sch.init({ now: () => now, ics: () => baseIcs(icsLocal(new Date(evStart))), onEmit: (t) => fired.push(t) });
  sch.tick();
  assert.strictEqual(fired.length, 1);

  // 无 ics（feature off）→ 静默
  sch._reset(); fired.length = 0;
  sch.init({ now: () => now, onEmit: (t) => fired.push(t) });
  sch.tick();
  assert.strictEqual(fired.length, 0);
});
