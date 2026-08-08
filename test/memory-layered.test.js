const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMemoryService } = require('../src/services/memory-service');
const { createMemoryStore } = require('../src/services/memory-store');

function createFixture(t, clockValue = '2026-08-07T10:00:00.000Z') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-layer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    service: createMemoryService(createMemoryStore({ filePath: path.join(directory, 'memory.json') }), {
      clock: () => new Date(clockValue),
      createId: (() => { let index = 0; return () => `mem-${++index}`; })(),
    }),
  };
}

test('Given a remember request When persisted Then the layered defaults are applied (status/weight/accessCount)', (t) => {
  const { service } = createFixture(t);
  const memory = service.remember({ type: 'preference', content: 'User likes tea', explicit: true, importance: 0.9 });

  assert.equal(memory.status, 'active');
  assert.equal(memory.weight, 0.9);          // 热度初值 = importance
  assert.equal(memory.accessCount, 0);
  assert.equal(memory.isSummary, false);
  assert.deepEqual(memory.subEntryIds, []);
  assert.deepEqual(memory.conflictWith, []);
});

test('Given a core-tagged remember When coreMemories runs Then only core entries are returned as constant context', (t) => {
  const { service } = createFixture(t);
  service.remember({ type: 'preference', content: 'User likes tea', explicit: true, importance: 0.9 });
  service.remember({ type: 'profile', content: 'User lives in Kyoto', explicit: true, importance: 0.8, status: 'core' });
  service.remember({ type: 'relationship', content: 'User has a cat', explicit: true, importance: 0.7, status: 'core' });

  const core = service.coreMemories();
  assert.ok(core.includes('User lives in Kyoto'));
  assert.ok(core.includes('User has a cat'));
  assert.ok(!core.includes('User likes tea')); // 普通记忆不进 core
});

test('Given layered contexts When networkConsent is off Then both core and working are empty (privacy preserved)', (t) => {
  const { service } = createFixture(t);
  service.remember({ type: 'preference', content: 'User likes tea', explicit: true, importance: 0.9 });
  service.remember({ type: 'profile', content: 'User lives in Kyoto', explicit: true, importance: 0.8, status: 'core' });

  const offline = service.buildLayeredContext({ query: 'tea', networkAllowed: false });
  assert.equal(offline.core, '');
  assert.equal(offline.working, '');
});

test('Given layered contexts When networkConsent is on Then core is constant and working is query-relative', (t) => {
  const { service } = createFixture(t);
  service.remember({ type: 'preference', content: 'User likes jasmine tea', explicit: true, importance: 0.9 });
  service.remember({ type: 'episodic', content: 'Discussed a toy train', explicit: true, importance: 0.7 });
  service.remember({ type: 'profile', content: 'User lives in Kyoto', explicit: true, importance: 0.8, status: 'core' });

  const ctx = service.buildLayeredContext({ query: 'tea', networkAllowed: true });

  // core：只含常驻核心，与查询无关
  assert.ok(ctx.core.includes('User lives in Kyoto'));
  assert.ok(!ctx.core.includes('jasmine tea'));
  // working：按 query 召回
  assert.ok(ctx.working.includes('jasmine tea'));
  assert.ok(!ctx.working.includes('toy train'));
  // 两者互相独立、可分别注入
  assert.equal(typeof ctx.core, 'string');
  assert.equal(typeof ctx.working, 'string');
});

test('Given legacy v1-style plain memories When a new store loads them Then layered defaults are filled without data loss', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-memory-v1up-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'memory.json');

  // 手工写一份 v1 老格式（无分层字段）
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    data: {
      memories: [{ id: 'old-1', type: 'preference', content: 'User likes coffee', importance: 0.8, confidence: 1, source: 'user' }],
      blocked: [],
    },
  }, null, 2));

  // 新 store（v2）读取应迁移补齐分层字段，且内容不丢
  const service = createMemoryService(createMemoryStore({ filePath }));
  const list = service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].content, 'User likes coffee');
  assert.equal(list[0].status, 'active');
  assert.equal(list[0].weight, 0.8);
  assert.equal(list[0].accessCount, 0);
  assert.deepEqual(list[0].subEntryIds, []);
});
