const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const storage = require('../src/services/storage');
const petState = require('../src/systems/pet-state');
const { createEventBus } = require('../src/services/event-bus');
const E = require('../src/contracts/events');

const MS_HOUR = 3600 * 1000;
const MS_DAY = 24 * MS_HOUR;

let dir;
let base;
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-pet-'));
  storage._reset();
  storage.setRuntimeDir(dir);
  petState._reset();
  petState.init({});
  base = Date.now();
  petState._setNow(() => base);
}
function teardown() {
  petState._reset();
  storage._reset();
  storage.setRuntimeDir(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

test('pet: 初始默认状态', () => {
  setup();
  try {
    const s = petState.getState();
    assert.equal(s.emotion.mood, '平静');
    assert.equal(s.emotion.moodScore, 60);
    assert.equal(s.affection.value, 0);
    assert.equal(s.nurture.stage, '幼年');
    assert.equal(s.nurture.experience, 0);
  } finally {
    teardown();
  }
});

test('pet: 关注事件改变情绪/好感/养成', () => {
  setup();
  try {
    petState.applyEvent(E.PET.GREETING);
    const s = petState.getState();
    assert.equal(s.emotion.moodScore, 66);      // 60 + 6
    assert.equal(s.emotion.loneliness, 17);     // 25 - 8
    assert.ok(s.affection.value > 0);
    assert.equal(s.nurture.experience, 3);      // GREETING 给 3
  } finally {
    teardown();
  }
});

test('pet: 夸奖提升更多情绪且好感更高', () => {
  // 分别在独立干净状态下对比 Greeting 与 Praise
  const gainsFor = (evt) => {
    setup();
    try {
      petState.applyEvent(evt);
      return petState.getState();
    } finally {
      teardown();
    }
  };
  const greet = gainsFor(E.PET.GREETING);
  const praise = gainsFor(E.PET.PRAISE);
  assert.equal(greet.nurture.experience, 3);
  assert.equal(praise.nurture.experience, 4);
  assert.equal(greet.emotion.moodScore, 66);
  assert.equal(praise.emotion.moodScore, 70);
  assert.ok(praise.affection.value > greet.affection.value, 'Praise 好感增额应高于 Greeting（基准 3>1）');
  assert.ok(praise.nurture.experience > greet.nurture.experience, 'Praise 经验应更高');
});

test('pet: clamp 限幅 0-100', () => {
  setup();
  try {
    // 连续多次夸奖把 moodScore 打到 100 封顶、health 不超
    for (let i = 0; i < 20; i++) petState.applyEvent(E.PET.PRAISE);
    const s = petState.getState();
    assert.ok(s.emotion.moodScore <= 100);
    // 连续喂食 health 封顶 100
    for (let i = 0; i < 20; i++) petState.applyEvent(E.PET.FEED);
    assert.ok(petState.getState().emotion.health <= 100);
  } finally {
    teardown();
  }
});

test('pet: 好感每日上限', () => {
  setup();
  try {
    let before = -1;
    for (let i = 0; i < 40; i++) {
      petState.applyEvent(E.PET.PRAISE);
      const v = petState.getState().affection.value;
      if (before >= 0) assert.ok(v >= before, '好感只增不减');
      before = v;
    }
    // 同一日内累计好感不超过（初始 0 + 日上限 12，加上可能的误差）
    assert.ok(petState.getState().affection.value <= 12.01);
    assert.ok(petState.getState().affection.dayGain <= 12.01);
  } finally {
    teardown();
  }
});

test('pet: 睡前熬夜事件消耗精神', () => {
  setup();
  try {
    const e0 = petState.getState().emotion.energy;
    petState.applyEvent(E.PET.LATE_NIGHT);
    const e1 = petState.getState().emotion.energy;
    assert.ok(e1 < e0);
    assert.ok(petState.getState().emotion.stress > 15);
  } finally {
    teardown();
  }
});

test('pet: 惰性演化——情绪按自然时间回归基线', () => {
  setup();
  try {
    petState.applyEvent(E.PET.PRAISE); // moodScore -> 70, stress ->12
    const hi = petState.getState().emotion.moodScore;
    assert.ok(hi > 60);
    // 推时钟 12 小时（半天）后应回落到更接近基线
    petState._setNow(() => base + 12 * MS_HOUR);
    const reg = petState.getState().emotion.moodScore;
    assert.ok(reg < hi);
    assert.ok(reg > 60 - 1 && reg < 70, `回归到基线附近: ${reg}`);
  } finally {
    teardown();
  }
});

test('pet: 惰性演化——好感冷落衰减并带下限（关机 3 天）', () => {
  setup();
  try {
    for (let i = 0; i < 10; i++) petState.applyEvent(E.PET.CONVERSATION); // 积累好感（达日上限 12）
    const before = petState.getState().affection.value;
    assert.ok(before > 10 && before <= 12.01, `有足够积累以便观察衰减: ${before}`);
    // 关机 30 天
    petState._setNow(() => base + 30 * MS_DAY);
    const after = petState.getState().affection.value;
    assert.ok(after < before, '冷落应衰减');
    assert.ok(after >= 10, '衰减不低于下限 10');
    // 再模拟很久很久
    petState._setNow(() => base + 1000 * MS_DAY);
    assert.ok(petState.getState().affection.value >= 10, '长期不衰减到下限之下');
  } finally {
    teardown();
  }
});

test('pet: 惰性演化——health 随自然时间下降、喂食恢复', () => {
  setup();
  try {
    petState.applyEvent(E.PET.FEED); // 先写入 updatedAt（health=100）
    assert.equal(petState.getState().emotion.health, 100);
    // 推 2 天
    petState._setNow(() => base + 2 * MS_DAY);
    const low = petState.getState().emotion.health;
    assert.ok(low < 100, `health 应随时间下降: ${low}`);
    petState.applyEvent(E.PET.FEED);
    const after = petState.getState().emotion.health;
    assert.ok(after > low, '喂食恢复 health');
  } finally {
    teardown();
  }
});

test('pet: 养成阶段晋升并广播 stageUp 事件', () => {
  setup();
  try {
    const bus = createEventBus();
    petState._reset();
    petState.init({ eventBus: bus });
    const ups = [];
    bus.on(E.PET.STAGE_UP, (e) => ups.push(`${e.from}->${e.to}`));
    // FEED 每次给 6 经验，100 经验进成长
    for (let i = 0; i < 20; i++) petState.applyEvent(E.PET.FEED);
    assert.equal(petState.getStage(), '成长');
    assert.ok(ups.includes('幼年->成长'), `收到晋升广播: ${ups}`);
  } finally {
    teardown();
  }
});

test('pet: 事件表有界', () => {
  setup();
  try {
    petState._setNow(() => {
      base += MS_HOUR;
      return base;
    });
    for (let i = 0; i < 200; i++) petState.applyEvent(E.PET.GREETING);
    assert.ok(petState.getState().events.length <= 50);
  } finally {
    teardown();
  }
});

test('pet: 持久化跨"重启"保留（含惰性演化）', () => {
  setup();
  try {
    petState.applyEvent(E.PET.GREETING);
    // 模拟重启：清空外部状态，但保持同一 runtime dir，重现 schema → 读回原值
    petState._reset();
    storage._reset(); // 保持 schema map 清空以模拟干净启动，但文件仍在 dir
    petState._setNow(() => base);
    petState.init({});
    const s = petState.getState();
    assert.equal(s.emotion.moodScore, 66); // 持久化值保留（同一时刻读取）
    assert.equal(s.nurture.experience, 3);
  } finally {
    teardown();
  }
});

test('pet: 未知事件类型仅记录不改变状态（留位语义）', () => {
  setup();
  try {
    const before = petState.getState();
    petState.applyEvent(E.PET.STAGE_UP); // 不是 deltas 事件（预留位）
    const after = petState.getState();
    assert.equal(after.emotion.moodScore, before.emotion.moodScore);
    assert.equal(after.affection.value, before.affection.value);
    assert.equal(after.nurture.experience, before.nurture.experience);
    assert.ok(after.events.length > 0, '记录了一条事件');
  } finally {
    teardown();
  }
});
