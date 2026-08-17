// pet 状态系统：情绪 / 好感 / 养成（自主体 P0-2）。
//
// 设计要点（docs/自主桌宠架构与路线图.md）：
// - 惰性演化 evolve(state, now)：状态值不在运行 tick 里硬改，而是持久化各子块的
//   updatedAt(墙钟)，每次读取/计算时用「当前墙钟 - updatedAt」按真实流逝时长演化。
//   → 关机离线期间，情绪回归、好感冷落衰减、健康下降都按真实自然时间继续。
// - 三系统时间尺度：情绪=小时级波动(自然回归基线)；好感=天级累积(冷落衰减带下限)；
//   养成=阶段制只进不退。
// - 事件 deltas 表可扩展：新增事件只需在 DELTAS/NURTURE/AFFECTION_BASE 加一行。
// - 养成阶段晋升：写将 stageUp 事件广播到 EventBus（P1 记忆 / P4 日记将来订阅）。
//
// 纯逻辑领域：不依赖 Electron / 窗口 / 渲染，全部可单测。

const storage = require('../services/storage');
const E = require('../contracts/events');

// —— 面向可扩展的差错容错配置 ——
const SCHEMA_KEY = 'pet_state';
const SCHEMA_VERSION = 1;
const MAX_EVENTS = 50;            // 事件表有界，防无限膨胀

// 各状态维度基线（自然回归目标）
const BASELINE = Object.freeze({
  moodScore: 60,
  energy: 80,
  stress: 15,
  loneliness: 30,
});
// 半衰期（小时）：心跳多久向基线靠拢一半
const HALFLIFE_H = Object.freeze({
  moodScore: 6,
  energy: 10,
  stress: 8,
  loneliness: 36,
});
// 健康自然下降：每 12 小时 -5（需要照顾，喂食恢复）
const HEALTH_DECAY_PER_12H = 5;
const HEALTH_DECAY_HOURS = 12;

// moodScore → mood 离散标签
const MOOD_TAGS = Object.freeze([
  { max: 30, tag: '低沉' },
  { max: 65, tag: '平静' },
  { max: 85, tag: '开心' },
  { max: 100, tag: '兴奋' },
]);

// 好感
const AFFECTION_FLOOR = 10;             // 冷落衰减下限（不会归零）
const AFFECTION_DAILY_CAP = 12;         // 每日好感增长上限（防单日狂刷）
const COLD_GRACE_DAYS = 1;              // 最后一次互动后 N 天内不衰减
const COLD_DECAY_PER_DAY = 0.5;         // 超过宽限期后每天衰减量

// 养成阶段阈值（经验只进不退）
const STAGES = Object.freeze([
  { stage: '幼年', exp: 0 },
  { stage: '成长', exp: 100 },
  { stage: '成熟', exp: 300 },
]);

const DEFAULT_STATE = Object.freeze({
  emotion: { moodScore: 60, energy: 80, stress: 15, loneliness: 25, health: 100, mood: '平静', updatedAt: null },
  affection: { value: 0, updatedAt: null, lastInteractionAt: null, day: '', dayGain: 0 },
  nurture: { experience: 0, stage: '幼年', updatedAt: null },
  events: [],
});

// 每种状态触发事件的情绪增量（扩展位：新事件在此加一行）
const DELTAS = Object.freeze({
  [E.PET.GREETING]: { moodScore: 6, loneliness: -8, stress: -2, energy: 2 },
  [E.PET.CONVERSATION]: { moodScore: 3, loneliness: -3, stress: -1, energy: -2 },
  [E.PET.PRAISE]: { moodScore: 10, stress: -3, loneliness: -2, energy: -2 },
  [E.PET.LATE_NIGHT]: { stress: 5, energy: -10, moodScore: -3 },
  [E.PET.LONG_SESSION]: { energy: -8, stress: 3, moodScore: -2 },
  [E.PET.NEGLECT]: { loneliness: 8, stress: 2, moodScore: -3 },
  [E.PET.FEED]: { health: 25, moodScore: 3, energy: 5 },
});

// 各事件给的好感基准值（受情绪调制 + 日上限）
const AFFECTION_BASE = Object.freeze({
  [E.PET.GREETING]: 1,
  [E.PET.CONVERSATION]: 2,
  [E.PET.PRAISE]: 3,
  [E.PET.FEED]: 2,
  [E.PET.LATE_NIGHT]: 0.5,
  [E.PET.LONG_SESSION]: 0.5,
  [E.PET.NEGLECT]: 0,
});

// 各事件给的养成经验（只增不减；负面事件给 0）
const NURTURE = Object.freeze({
  [E.PET.GREETING]: 3,
  [E.PET.CONVERSATION]: 2,
  [E.PET.PRAISE]: 4,
  [E.PET.FEED]: 6,
  [E.PET.LATE_NIGHT]: 0,
  [E.PET.LONG_SESSION]: 0,
  [E.PET.NEGLECT]: 0,
});

let bus = null;
// 测试可注入时钟：_setNow(() => timestamp)
let nowFn = () => Date.now();

const MS_DAY = 24 * 60 * 60 * 1000;
const MS_HOUR = 60 * 60 * 1000;

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

function dayOf(ts) {
  // 用本地日期字符串作"天"切分（跨天持续累计，仅做每日上限窗口的判据）
  const dt = new Date(ts);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function moodFor(score) {
  const s = clamp(score);
  for (const t of MOOD_TAGS) if (s <= t.max) return t.tag;
  return '平静';
}

function stageFor(exp) {
  let cur = STAGES[0].stage;
  for (const s of STAGES) if (exp >= s.exp) cur = s.stage;
  return cur;
}

// 深合并默认值（补缺失子块的内字段）
function deepDefaults(defaults, doc) {
  const out = { ...doc };
  for (const key of Object.keys(defaults)) {
    if (defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      out[key] = { ...defaults[key], ...(out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}) };
    } else if (out[key] === undefined) {
      out[key] = defaults[key];
    }
  }
  return out;
}

function normalize(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const s = deepDefaults(DEFAULT_STATE, base);
  s.emotion.moodScore = clamp(Number(s.emotion.moodScore) || BASELINE.moodScore);
  s.emotion.energy = clamp(Number(s.emotion.energy) || BASELINE.energy);
  s.emotion.stress = clamp(Number(s.emotion.stress) || BASELINE.stress);
  s.emotion.loneliness = clamp(Number(s.emotion.loneliness) || BASELINE.loneliness);
  s.emotion.health = clamp(Number(s.emotion.health) || 100);
  s.emotion.mood = moodFor(s.emotion.moodScore);
  s.affection.value = Number(s.affection.value) || 0;
  s.affection.dayGain = Number(s.affection.dayGain) || 0;
  s.nurture.experience = Math.max(0, Number(s.nurture.experience) || 0);
  s.nurture.stage = stageFor(s.nurture.experience);
  if (!Array.isArray(s.events)) s.events = [];
  s.events = s.events.slice(-MAX_EVENTS);
  return s;
}

// 向基线回归：value → base + (value-base)*exp(-ln2*elapsedH/halflifeH)
function regress(value, base, elapsedH, halflifeH) {
  const k = -Math.LN2 * elapsedH / (halflifeH || 1);
  return base + (value - base) * Math.exp(k);
}

// 惰性演化：按真实墙钟流逝演化 emotion / affection / nurture 各子块。
// 纯函数：不写存储。
function evolve(state, now) {
  const s = normalize(state);
  // —— emotion ——
  const e = s.emotion;
  const sleptH = (Number.isFinite(e.updatedAt) && e.updatedAt ? (now - e.updatedAt) / MS_HOUR : 0);
  if (sleptH > 0) {
    e.moodScore = clamp(regress(e.moodScore, BASELINE.moodScore, sleptH, HALFLIFE_H.moodScore));
    e.energy = clamp(regress(e.energy, BASELINE.energy, sleptH, HALFLIFE_H.energy));
    e.stress = clamp(regress(e.stress, BASELINE.stress, sleptH, HALFLIFE_H.stress));
    e.loneliness = clamp(regress(e.loneliness, BASELINE.loneliness, sleptH, HALFLIFE_H.loneliness));
    e.health = clamp(e.health - (sleptH / HEALTH_DECAY_HOURS) * HEALTH_DECAY_PER_12H);
  }
  e.mood = moodFor(e.moodScore);
  e.updatedAt = now;

  // —— affection（冷落衰减，带下限）——
  const a = s.affection;
  if (Number.isFinite(a.lastInteractionAt) && a.lastInteractionAt) {
    const idleDays = (now - a.lastInteractionAt) / MS_DAY;
    if (idleDays > COLD_GRACE_DAYS) {
      const decay = (idleDays - COLD_GRACE_DAYS) * COLD_DECAY_PER_DAY;
      a.value = Math.max(AFFECTION_FLOOR, a.value - decay);
    }
  }
  // 每日上限窗口滚动
  const today = dayOf(now);
  if (a.day !== today) {
    a.day = today;
    a.dayGain = 0;
  }
  a.updatedAt = now;

  // —— nurture（只进不退，无演化）——
  s.nurture.updatedAt = now;

  return s;
}

function readRaw() {
  const doc = storage.read(SCHEMA_KEY);
  return doc && typeof doc === 'object' ? doc : {};
}

// 返回当前（惰性演化后）状态
function getState() {
  if (!storage.has(SCHEMA_KEY)) return normalize(DEFAULT_STATE);
  return evolve(readRaw(), nowFn());
}

// 自然语言状态描述（供对话 system prompt / 面板展示）。已在内部惰性演化。
function describe() {
  return describeState(getState());
}

function describeState(s) {
  const e = s.emotion;
  const a = s.affection.value;
  // 好感→关系亲密度提示（影响人格画像/口吻的软信号）
  let relation;
  if (a < 25) relation = '你们还比较生疏，她对你礼貌但略显拘谨';
  else if (a < 60) relation = '你们正在慢慢熟络，她开始愿意亲近你';
  else relation = '她对你非常亲近，会撒娇、很依赖你';
  const parts = [
    `心情：${e.mood}(${Math.round(e.moodScore)}/100)；体力 ${Math.round(e.energy)}/100；压力 ${Math.round(e.stress)}/100；孤独 ${Math.round(e.loneliness)}/100；健康 ${Math.round(e.health)}/100`,
    `对主人好感：${Math.round(a)}/100。${relation}。`,
    `成长阶段：${s.nurture.stage}（经验 ${s.nurture.experience}）`,
  ];
  return parts.join('\n');
}

// 好感增量：基础值 * 情绪调制（心情好加成多），受每日上限约束
function affectionGain(type, emotion, affection, now) {
  const base = AFFECTION_BASE[type];
  if (!base || base <= 0) return 0;
  const mod = 0.5 + (emotion.moodScore / 100) * 0.5; // 0.5..1.0
  let gain = base * mod;
  // 每日上限
  const remaining = AFFECTION_DAILY_CAP - affection.dayGain;
  gain = Math.min(gain, Math.max(0, remaining));
  return Math.max(0, gain);
}

function pushEvent(type, s, now) {
  s.events.push({ type, value: 0, createdAt: now });
  if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS);
}

// 对状态触发事件做响应：查 deltas → 更新情绪/好感/养成 → 持久化 → 广播晋升。
// 返回演化并应用事件后的最新状态（深拷贝）。
function applyEvent(type) {
  if (!storage.has(SCHEMA_KEY)) throw new Error('pet-state 未初始化');
  const now = nowFn();
  let s = evolve(readRaw(), now);
  const d = DELTAS[type];
  if (d) {
    const e = s.emotion;
    e.moodScore = clamp(e.moodScore + (d.moodScore || 0));
    e.energy = clamp(e.energy + (d.energy || 0));
    e.stress = clamp(e.stress + (d.stress || 0));
    e.loneliness = clamp(e.loneliness + (d.loneliness || 0));
    e.health = clamp(e.health + (d.health || 0));
    e.mood = moodFor(e.moodScore);
    e.updatedAt = now;

    // 好感
    const beforeAff = s.affection.value;
    const gain = affectionGain(type, e, s.affection, now);
    s.affection.value += gain;
    s.affection.dayGain += gain;
    s.affection.lastInteractionAt = now; // 互动重置冷落
    s.affection.updatedAt = now;

    // 养成经验 + 阶段晋升
    const prevStage = s.nurture.stage;
    s.nurture.experience += (NURTURE[type] || 0);
    s.nurture.stage = stageFor(s.nurture.experience);
    s.nurture.updatedAt = now;

    pushEvent(type, s, now);
    storage.write(SCHEMA_KEY, { emotion: s.emotion, affection: s.affection, nurture: s.nurture, events: s.events });

    // 广播该事件（供 proactive 主动关怀 / 记忆 / 日记等系统订阅反应）
    if (bus) bus.emit(type, { emotion: s.emotion, affection: s.affection, nurture: s.nurture });

    if (prevStage !== s.nurture.stage && bus) {
      // 广播晋升（P1 记忆 / P4 日记将来订阅）
      bus.emit(E.PET.STAGE_UP, { from: prevStage, to: s.nurture.stage, experience: s.nurture.experience });
    }
    return { emotion: { ...s.emotion }, affection: { ...s.affection }, nurture: { ...s.nurture }, events: [...s.events] };
  }

  // 未知/预留事件类型：仅记录事件，不改变状态（留位语义）
  pushEvent(type, s, now);
  storage.write(SCHEMA_KEY, { emotion: s.emotion, affection: s.affection, nurture: s.nurture, events: s.events });
  return { emotion: { ...s.emotion }, affection: { ...s.affection }, nurture: { ...s.nurture }, events: [...s.events] };
}

function getStage() {
  return getState().nurture.stage;
}

// 初始化：注册 schema + 注入事件总线（main 装配时调用）
function init({ eventBus } = {}) {
  bus = eventBus || null;
  storage.register(SCHEMA_KEY, {
    version: SCHEMA_VERSION,
    defaults: DEFAULT_STATE,
    migrations: {},
    normalize,
  });
}

// 测试工具
function _setNow(fn) {
  nowFn = fn || (() => Date.now());
}
function _reset() {
  bus = null;
  nowFn = () => Date.now();
}

module.exports = { init, getState, applyEvent, getStage, evolve, describe, describeFromState: describeState, _setNow, _reset };
