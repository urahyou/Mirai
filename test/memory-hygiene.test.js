const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryService } = require('../src/services/memory-service');
const { createMemoryStore } = require('../src/services/memory-store');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-hygiene-'));
  const filePath = path.join(dir, 'memory.json');
  let now = new Date('2026-08-08T00:00:00.000Z');
  const service = createMemoryService(createMemoryStore({ filePath }), {
    clock: () => new Date(now),
    createId: (() => { let i = 0; return () => `id-${++i}`; })(),
  });
  return { service, filePath, setNow: (iso) => { now = new Date(iso); }, dir };
}

test('soft delete moves memory to trash, not gone; restore brings it back', () => {
  const { service } = setup();
  const m = service.remember({ type: 'preference', content: 'likes tea', explicit: true, importance: 0.8 });
  assert.equal(service.remove(m.id), true);

  // 默认 list 不含已删
  assert.deepEqual(service.list().map((x) => x.id), []);
  // 回收站可见
  assert.deepEqual(service.list({ trashOnly: true }).map((x) => x.id), [m.id]);

  const restored = service.restore(m.id);
  assert.ok(restored, 'restore returns memory');
  assert.deepEqual(service.list().map((x) => x.id), [m.id]);
  assert.deepEqual(service.list({ trashOnly: true }).map((x) => x.id), []);
});

test('purge permanently removes from trash', () => {
  const { service } = setup();
  const m = service.remember({ type: 'preference', content: 'temp', explicit: true, importance: 0.6 });
  service.remove(m.id);
  assert.equal(service.purge(m.id), true);
  assert.deepEqual(service.list({ trashOnly: true }).map((x) => x.id), []);
  assert.equal(service.purge(m.id), false);
});

test('forget by content moves to trash (soft) and export excludes trashed', () => {
  const { service } = setup();
  service.remember({ type: 'preference', content: 'hates cilantro', explicit: true, importance: 0.9 });
  assert.equal(service.forget({ type: 'preference', content: 'hates cilantro' }), true);
  assert.deepEqual(service.list().map((x) => x.content), []);
  assert.equal(service.list({ trashOnly: true }).length, 1);
  // export 只含有效记忆
  assert.equal(service.exportData().data.memories.length, 0);
});

test('hygiene flags expired, low-value, unused, duplicate and legacy memories', () => {
  const { service, setNow } = setup();
  // expired（一次性日程已过）
  service.remember({ type: 'schedule', content: 'trip on 08-01', explicit: true, importance: 0.5, expiresAt: '2026-08-02T00:00:00.000Z' });
  // low value（Judge 等自动写入的低 importance/confidence，本就会被降权对待）
  service.remember({ type: 'preference', content: 'maybe likes rain', explicit: true, importance: 0.2, confidence: 0.4, source: 'judge' });
  // legacy（source 非 judge/user）
  service.remember({ type: 'work', content: 'legacy project note', explicit: true, importance: 0.8, source: 'conversation' });
  // duplicate
  service.remember({ type: 'preference', content: 'loves cats', explicit: true, importance: 0.9 });
  service.remember({ type: 'preference', content: 'loves cats', explicit: true, importance: 0.8 });

  setNow('2026-08-08T00:00:00.000Z');
  const tags = service.hygiene().map((s) => `${s.id}:${s.tag}`);
  assert.ok(tags.some((t) => t.endsWith('expired')), 'expired flagged');
  assert.ok(tags.some((t) => t.endsWith('lowValue')), 'lowValue flagged');
  assert.ok(tags.some((t) => t.endsWith('legacy')), 'legacy flagged');
  assert.ok(tags.some((t) => t.endsWith('duplicate')), 'duplicate flagged');
});

test('update can promote status to core and demote back, controlling layers', () => {
  const { service } = setup();
  const m = service.remember({ type: 'profile', content: 'name is xiao', explicit: true, importance: 0.6 });
  assert.equal(m.status, 'active');
  const promoted = service.update(m.id, { status: 'core' });
  assert.equal(promoted.status, 'core');
  // core 出现在 coreMemories 中
  assert.ok(service.coreMemories().includes('name is xiao'));
  const demoted = service.update(m.id, { status: 'active' });
  assert.equal(demoted.status, 'active');
  assert.equal(service.coreMemories().includes('name is xiao'), false);
});
