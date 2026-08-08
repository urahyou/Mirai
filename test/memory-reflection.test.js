const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryService } = require('../src/services/memory-service');
const { createMemoryStore } = require('../src/services/memory-store');
const { selectCandidates, runReflection } = require('../src/services/memory-reflection');

const T0 = new Date('2026-08-08T08:00:00.000Z');
function makeService(fixedNow = T0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-refl-'));
  let now = fixedNow;
  const service = createMemoryService(createMemoryStore({ filePath: path.join(dir, 'memory.json') }), {
    clock: () => new Date(now),
    createId: (() => { let i = 0; return () => `r-${++i}`; })(),
  });
  return { service, setNow: (n) => { now = n; } };
}

test('selectCandidates picks low-heat, long-unaccessed same-type memories', () => {
  const { service } = makeService();
  const old = service.remember({ type: 'preference', content: 'A', explicit: true, importance: 0.3 });
  service.remember({ type: 'preference', content: 'B', explicit: true, importance: 0.3 });
  service.remember({ type: 'preference', content: 'C', explicit: true, importance: 0.3 });
  service.remember({ type: 'preference', content: 'HOT', explicit: true, importance: 0.9 });
  const picked = selectCandidates(service, { now: new Date('2030-01-01T00:00:00.000Z'), minAgeMs: 0, maxCount: 3 });
  assert.ok(picked.length >= 2);
  assert.ok(picked.some((m) => m.id === old.id));
});

test('selectCandidates protects core, summary entries', () => {
  const { service } = makeService();
  // 造一个真实 summary（用非 core 条 reflect）
  const s1 = service.remember({ type: 'preference', content: 'p1', explicit: true, importance: 0.3 });
  const s2 = service.remember({ type: 'preference', content: 'p2', explicit: true, importance: 0.3 });
  const sum = service.reflect({ ids: [s1.id, s2.id], content: 'sum', type: 'preference', importance: 0.5 });
  assert.ok(sum && sum.isSummary);
  // 造一条 core
  const c = service.remember({ type: 'profile', content: 'core-mem', explicit: true, importance: 0.95 });
  service.update(c.id, { status: 'core' });
  const picked = selectCandidates(service, { now: new Date('2099-01-01T00:00:00.000Z'), minAgeMs: 0, maxCount: 10 });
  assert.ok(picked.every((m) => !m.isSummary), '不放 summary');
  assert.ok(picked.every((m) => m.status !== 'core'), '不放 core');
});

test('runReflection compresses picks into a summary and marks originals compressed', async () => {
  const { service } = makeService();
  for (let i = 0; i < 4; i++) {
    service.remember({ type: 'episodic', content: `episode-${i}`, explicit: true, importance: 0.3 });
  }
  const ids = service.list().map((m) => m.id);
  const count = await runReflection({
    service,
    provider: 'p',
    now: new Date('2030-01-01T00:00:00.000Z'),
    minAgeMs: 0,
    completionFn: async () => '压缩后的摘要内容',
  });
  assert.equal(count, 3, '压缩 3 条');
  const all = service.list({ includeArchived: true });
  const summary = all.find((m) => m.isSummary);
  assert.ok(summary, '产生 summary 条');
  assert.ok(summary.subEntryIds.length === 3, 'subEntryIds 溯源 3 条');
  // 原条标 compressed
  const compressed = all.filter((m) => m.status === 'compressed');
  assert.equal(compressed.length, 3, '原 3 条标 compressed');
});

test('runReflection returns 0 when LLM fails, leaving data untouched', async () => {
  const { service } = makeService();
  for (let i = 0; i < 4; i++) {
    service.remember({ type: 'work', content: `work-${i}`, explicit: true, importance: 0.3 });
  }
  const count = await runReflection({
    service,
    now: new Date('2030-01-01T00:00:00.000Z'),
    minAgeMs: 0,
    completionFn: async () => { throw new Error('llm down'); },
  });
  assert.equal(count, 0);
  assert.equal(service.list({ includeArchived: true }).filter((m) => m.status === 'compressed').length, 0);
  assert.equal(service.list({ includeArchived: true }).filter((m) => m.isSummary).length, 0);
});

test('runReflection returns 0 when too few candidates', async () => {
  const { service } = makeService();
  service.remember({ type: 'preference', content: 'only-one', explicit: true, importance: 0.3 });
  const count = await runReflection({ service, now: new Date('2030-01-01T00:00:00.000Z'), minAgeMs: 0 });
  assert.equal(count, 0);
});
