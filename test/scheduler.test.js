const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createJsonStorage } = require('../src/services/json-storage');
const { createSchedulerService } = require('../src/services/scheduler-service');
const { reminderGate } = require('../src/services/reminder-gate');

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-schedule-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    store: createJsonStorage({ filePath: path.join(directory, 'schedules.json'), schemaVersion: 1, defaults: { schedules: [] } }),
  };
}

test('Given one-shot and repeating reminders When created then due and advanced Then one-shot disables after firing and repeat schedules the next occurrence', (t) => {
  const { store } = createFixture(t);
  const scheduler = createSchedulerService(store, { clock: () => new Date('2026-08-07T10:00:00.000Z') });

  const onshot = scheduler.create({ title: '去拿咖啡', runAt: '2026-08-07T09:00:00.000Z' });
  const daily = scheduler.create({ title: '每日站会', runAt: '2026-08-07T09:00:00.000Z', repeat: { interval: 'daily' } });
  assert.ok(onshot && daily);

  const dueNow = scheduler.due(new Date('2026-08-07T10:00:00.000Z'));
  assert.equal(dueNow.length, 2);

  scheduler.advance(onshot, new Date('2026-08-07T10:00:00.000Z'));
  scheduler.advance(daily, new Date('2026-08-07T10:00:00.000Z'));

  const firedOnce = scheduler.get(onshot.id);
  const repeated = scheduler.get(daily.id);
  assert.equal(firedOnce.enabled, false);
  assert.equal(repeated.repeat.interval, 'daily');
  assert.equal(repeated.runAt, '2026-08-08T09:00:00.000Z');

  assert.deepEqual(scheduler.due(new Date('2026-08-07T10:00:00.000Z')).length, 0);
});

test('Given rejected payloads When a reminder is created Then invalid or duplicate-unsafe input is refused', (t) => {
  const { store } = createFixture(t);
  const scheduler = createSchedulerService(store);
  assert.equal(scheduler.create({ runAt: '2026-08-07T09:00:00.000Z' }), null); // 缺 title
  assert.equal(scheduler.create({ title: 'x'.repeat(121), runAt: '2026-08-07T09:00:00.000Z' }), null); // title 超长
  assert.equal(scheduler.create({ title: 'ok', runAt: 'not-a-date' }), null); // 非法时间
});

test('Given quiet hours and a pause When a reminder fires Then the gate suppresses it but still allows delivery otherwise', () => {
  const settings = {
    enabled: true,
    pausedUntil: null,
    quietHours: { allow: [[9 * 60, 18 * 60]], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  };

  assert.deepEqual(reminderGate({ now: new Date(2026, 7, 7, 12, 0), proactiveSettings: settings }), { deliver: true, reason: 'ok' });
  assert.equal(reminderGate({ now: new Date(2026, 7, 7, 20, 0), proactiveSettings: settings }).deliver, false); // 安静时间

  assert.equal(reminderGate({ now: new Date(2026, 7, 7, 12, 0), proactiveSettings: { ...settings, pausedUntil: '2026-08-08T00:00:00.000Z' } }).deliver, false);
});

test('Given lastRunAt enforcement Then an already-delivered reminder is not re-fetched by due()', (t) => {
  const { store } = createFixture(t);
  const scheduler = createSchedulerService(store, { clock: () => new Date('2026-08-07T10:00:00.000Z') });
  const item = scheduler.create({ title: '事件', runAt: '2026-08-07T09:00:00.000Z' });
  scheduler.advance(item, new Date('2026-08-07T10:00:00.000Z'));
  assert.equal(scheduler.due(new Date('2026-08-07T10:00:00.000Z')).length, 0);
});