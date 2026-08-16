const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const storage = require('../src/services/storage');

let dir;
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-storage-'));
  storage._reset();
  storage.setRuntimeDir(dir);
}
function teardown() {
  storage.setRuntimeDir(null);
  storage._reset();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

test('storage: 注册后读默认值（无文件）', () => {
  setup();
  try {
    storage.register('demo', { version: 1, defaults: { moodScore: 50, mood: '平静' } });
    assert.deepEqual(storage.read('demo'), { moodScore: 50, mood: '平静' });
  } finally {
    teardown();
  }
});

test('storage: 读写 + 文件持久化', () => {
  setup();
  try {
    storage.register('demo', { version: 1, defaults: { moodScore: 50, mood: '平静' } });
    const out = storage.write('demo', { moodScore: 66 });
    assert.deepEqual(out, { moodScore: 66, mood: '平静' });
    // 磁盘上带 version
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.moodScore, 66);
    // 新实例读取（模拟重启：dir 不变、schema 重新注册）
    storage._reset();
    storage.register('demo', { version: 1, defaults: { moodScore: 50, mood: '平静' } });
    assert.deepEqual(storage.read('demo'), { moodScore: 66, mood: '平静' });
  } finally {
    teardown();
  }
});

test('storage: 迁移钩子逐级执行', () => {
  setup();
  try {
    // 制造 v2 的文件：把 v1 文档直接写成 v1 结构
    fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({ version: 1, moodScore: 80, mood: '开心' }), 'utf8');
    storage.register('demo', {
      version: 2,
      defaults: { moodScore: 50, mood: '平静' },
      migrations: {
        2: (doc) => ({ ...doc, energy: 70 }), // v1 -> v2 新增 energy
      },
    });
    const out = storage.read('demo');
    assert.equal(out.moodScore, 80);
    assert.equal(out.mood, '开心');
    assert.equal(out.energy, 70); // 迁移补入
  } finally {
    teardown();
  }
});

test('storage: 迁移钩子产出非法则回退默认值', () => {
  setup();
  try {
    fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({ version: 1, moodScore: 80 }), 'utf8');
    storage.register('demo', {
      version: 2,
      defaults: { moodScore: 50, mood: '平静' },
      migrations: { 2: () => null }, // 坏的迁移
    });
    assert.deepEqual(storage.read('demo'), { moodScore: 50, mood: '平静' }); // 安全回退默认
  } finally {
    teardown();
  }
});

test('storage: 损坏文件回退默认值', () => {
  setup();
  try {
    fs.writeFileSync(path.join(dir, 'demo.json'), '{ this is not json', 'utf8');
    storage.register('demo', { version: 1, defaults: { moodScore: 50, mood: '平静' } });
    assert.deepEqual(storage.read('demo'), { moodScore: 50, mood: '平静' });
  } finally {
    teardown();
  }
});

test('storage: 未知未来版本回退默认值', () => {
  setup();
  try {
    fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({ version: 99, moodScore: 90 }), 'utf8');
    storage.register('demo', { version: 1, defaults: { moodScore: 50, mood: '平静' } });
    assert.deepEqual(storage.read('demo'), { moodScore: 50, mood: '平静' });
  } finally {
    teardown();
  }
});

test('storage: normalize 校验兜底', () => {
  setup();
  try {
    storage.register('demo', {
      version: 1,
      defaults: { moodScore: 50, mood: '平静' },
      normalize: (doc) => {
        const score = Number(doc.moodScore);
        return { ...doc, moodScore: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 50 };
      },
    });
    assert.deepEqual(storage.write('demo', { moodScore: 9999 }), { moodScore: 100, mood: '平静' });
    assert.deepEqual(storage.write('demo', { moodScore: -5 }), { moodScore: 0, mood: '平静' });
  } finally {
    teardown();
  }
});

test('storage: 原子写后无残留临时文件', () => {
  setup();
  try {
    storage.register('demo', { version: 1, defaults: { a: 1 } });
    storage.write('demo', { a: 2 });
    storage.write('demo', { a: 3 });
    const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftover, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf8')).a, 3);
  } finally {
    teardown();
  }
});

test('storage: 写未注册 / 未初始化 抛错', () => {
  setup();
  try {
    assert.throws(() => storage.write('nope', { a: 1 }), /未注册/);
    storage.setRuntimeDir(null);
    storage.register('demo', { version: 1, defaults: { a: 1 } });
    assert.throws(() => storage.write('demo', { a: 1 }), /未初始化/);
  } finally {
    teardown();
  }
});
