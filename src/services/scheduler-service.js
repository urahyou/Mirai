const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  schedules: [],
  schemaVersion: SCHEMA_VERSION,
});

const TYPES = Object.freeze(['reminder', 'deadline', 'proactive']);
const REPEAT_INTERVALS = Object.freeze(['daily', 'weekly']);
const MAX_TITLE = 120;
const MAX_NOTE = 500;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validIso(value) {
  if (value == null) return false;
  const time = new Date(value);
  return !Number.isNaN(time.getTime());
}

function isValidRepeat(value) {
  return value === null || (value && typeof value === 'object' && REPEAT_INTERVALS.includes(value.interval));
}

function addInterval(iso, interval) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (interval === 'daily') date.setUTCDate(date.getUTCDate() + 1);
  if (interval === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString();
}

function nextOccurrence(fromIso, repeat) {
  return repeat ? addInterval(fromIso, repeat.interval) : null;
}

function createSchedulerService(storage, options = {}) {
  if (!storage || typeof storage.load !== 'function' || typeof storage.save !== 'function') {
    throw new TypeError('storage must provide load and save functions');
  }
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const createId = typeof options.createId === 'function' ? options.createId : crypto.randomUUID;

  function readDocument() {
    const value = storage.load();
    return value && typeof value === 'object' && Array.isArray(value.schedules)
      ? { schedules: value.schedules, schemaVersion: SCHEMA_VERSION }
      : clone(DEFAULTS);
  }

  function writeDocument(document) {
    storage.save({ schedules: document.schedules, schemaVersion: SCHEMA_VERSION });
  }

  function normalize(input, existing = null) {
    const source = input && typeof input === 'object' ? input : {};
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    const type = TYPES.includes(source.type) ? source.type : 'reminder';
    const note = typeof source.note === 'string' ? source.note.slice(0, MAX_NOTE) : '';
    const runAt = validIso(source.runAt) ? new Date(source.runAt).toISOString() : null;
    const repeat = isValidRepeat(source.repeat) ? source.repeat : (existing ? existing.repeat : null);
    const enabled = typeof source.enabled === 'boolean' ? source.enabled : (existing ? existing.enabled : true);
    if (!title || title.length > MAX_TITLE || !runAt) return null;
    return {
      id: existing ? existing.id : createId(),
      title,
      type,
      note,
      runAt,
      repeat,
      enabled,
      createdAt: existing ? existing.createdAt : clock().toISOString(),
      lastRunAt: existing ? existing.lastRunAt : null,
    };
  }

  function list({ includeDisabled = false } = {}) {
    const { schedules } = readDocument();
    return schedules.filter((schedule) => includeDisabled || schedule.enabled).map(clone);
  }

  function get(id) {
    const item = readDocument().schedules.find((schedule) => schedule.id === id);
    return item ? clone(item) : null;
  }

  function create(input) {
    const schedule = normalize(input);
    if (!schedule) return null;
    const document = readDocument();
    writeDocument({ ...document, schedules: [...document.schedules, schedule] });
    return clone(schedule);
  }

  function update(id, patch) {
    const document = readDocument();
    const existing = document.schedules.find((schedule) => schedule.id === id);
    if (!existing) return null;
    const candidate = { ...existing, ...(patch || {}), id: existing.id };
    const next = normalize(candidate, existing);
    if (!next) return null;
    const schedules = document.schedules.map((schedule) => schedule.id === id ? next : schedule);
    writeDocument({ ...document, schedules });
    return clone(next);
  }

  function remove(id) {
    const document = readDocument();
    const schedules = document.schedules.filter((schedule) => schedule.id !== id);
    if (schedules.length === document.schedules.length) return false;
    writeDocument({ ...document, schedules });
    return true;
  }

  // 到期且尚未执行的启用提醒。已执行（lastRunAt 等于该次 runAt）的不重复触发。
  function due(now = clock()) {
    const timestamp = now.toISOString();
    return readDocument().schedules.filter((schedule) => schedule.enabled && schedule.runAt <= timestamp && schedule.lastRunAt !== schedule.runAt);
  }

  // 提醒已送达：一次性提醒停用，重复提醒推进到下一次。
  function advance(schedule, happenedAt = clock()) {
    const document = readDocument();
    const existing = document.schedules.find((item) => item.id === schedule.id);
    if (!existing) return null;
    const timestamp = happenedAt.toISOString();
    const next = {
      ...existing,
      lastRunAt: existing.runAt,
      runAt: nextOccurrence(existing.runAt, existing.repeat) || existing.runAt,
      enabled: existing.repeat ? existing.enabled : false,
    };
    if (!existing.repeat) next.lastRunAt = timestamp;
    const schedules = document.schedules.map((item) => item.id === schedule.id ? next : item);
    writeDocument({ ...document, schedules });
    return clone(next);
  }

  function clearAll() {
    storage.save(clone(DEFAULTS));
  }

  return Object.freeze({
    list,
    get,
    create,
    update,
    remove,
    due,
    advance,
    clearAll,
    nextOccurrence,
  });
}

module.exports = { createSchedulerService, TYPES, REPEAT_INTERVALS, DEFAULTS };