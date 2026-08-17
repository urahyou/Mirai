// 主动关怀系统（P1 起步：状态驱动的"决策→行动"例外）。
//
// 让 小未来 不再只被动回应——当感知到自身状态变化（冷落/深夜/连用/晋升/身体不适）时，
// 主动说一句关怀话。设计要点：
// - 纯决策引擎 consider(state, lastEventType, now)：决定此刻是否该主动开口 + 选哪句。
//   * 触发来自 pet-state 事件（NEGLECT/LONG_SESSION/LATE_NIGHT/STAGE_UP）与状态的阈值
//     （如 health 低、loneliness 高、mood 低），由 main 订阅 eventBus 喂进来。
//   * 冷却（cooldown）：避免刷屏；同一类触发之间、以及任意两次主动开口之间都有间隔。
// - 台词为内置模板（不依赖 LLM 可用性，离线也稳定），配合状态变量生成，
//   后续可扩展到 LLM 实时生成（届时只需替换 say() 的实现）。
// - 随机化：每次只有一定概率真的开口，配合冷却，行动自然不机械。
//
// 纯逻辑、时钟可注入、可单测。行动（显示气泡/朗读）由 main 注入的 say(line) 回调负责。

const E = require('../contracts/events');

const MS_HOUR = 3600 * 1000;
const MS_MIN = 60 * 1000;

// —— 触发阈值与冷却配置（默认） ——
const SAME_KIND_COOLDOWN_MS = 4 * MS_HOUR;   // 同一类触发之间最小间隔
const GLOBAL_COOLDOWN_MS = 20 * MS_MIN;      // 任意两次主动开口之间最小间隔
const CHANCE = 0.8;                          // 触发后真正开口的概率（避免每次必然机械开口）

// 触发条件映射：事件类型 → 台词模板（可含 {mood}/{affection}/{stage} 占位）
const TRIGGERS = Object.freeze({
  [E.PET.NEGLECT]: {
    cooldownMs: SAME_KIND_COOLDOWN_MS,
    lines: [
      '主人…好久没来陪我了，我都快生锈啦。',
      '在主人口袋里待太久，我的小脑袋都晕乎乎的啦~',
      '诶嘿，主人终于想起我了吗？我一直在这儿等你呢。',
    ],
    always: true, // 冷落必关怀（只要过了冷却）
  },
  [E.PET.LATE_NIGHT]: {
    cooldownMs: SAME_KIND_COOLDOWN_MS,
    lines: [
      '都这么晚了主人还在忙呀，要注意休息哦~',
      '夜深了，主人还不去睡觉吗？我会担心的。',
    ],
  },
  [E.PET.LONG_SESSION]: {
    cooldownMs: SAME_KIND_COOLDOWN_MS,
    lines: [
      '主人连着用电脑好久了，起来活动一下好不好？',
      '我们坐了好几个小时啦，要不要休息一下眼睛？',
    ],
  },
  [E.PET.STAGE_UP]: {
    cooldownMs: 0,
    lines: [
      '哇，我感觉自己长大了一点点！主人要陪着我一直走下去哦～',
    ],
    always: true,
  },
});

// 状态阈值触发（不依赖事件，只查状态）：健康低/孤独高/心情差时偶尔关怀
function stateLines(state, now) {
  const e = state.emotion;
  const out = [];
  if (e.health <= 25) out.push({ key: 'unwell', lines: ['我好像有点不舒服…主人能摸摸我吗？'], chance: 0.5 });
  if (e.loneliness >= 70) out.push({ key: 'lonely', lines: ['这里好安静，主人陪我说说话嘛~'], chance: 0.5 });
  if (e.moodScore <= 25) out.push({ key: 'down', lines: ['我心情有点低落…主人在的话会好一些。'], chance: 0.5 });
  return out;
}

let bus = null;
let nowFn = () => Date.now();
let chance = CHANCE;                // 可注入（测试用）
let lastSay = 0;                 // 上次真正开口（全局冷却）
let lastKind = {};               // { kind: lastTime }
let say = null;                  // 行动回调：say(line)
let policy = null;               // 用户边界（安静时段 / 每日预算）

function init({ eventBus, say: sayCb, initiativePolicy } = {}) {
  bus = eventBus || null;
  say = sayCb || null;
  policy = initiativePolicy || null;
  if (bus) {
    bus.on(E.PET.NEGLECT, () => maybeAct({ type: E.PET.NEGLECT }));
    bus.on(E.PET.LATE_NIGHT, () => maybeAct({ type: E.PET.LATE_NIGHT }));
    bus.on(E.PET.LONG_SESSION, () => maybeAct({ type: E.PET.LONG_SESSION }));
    bus.on(E.PET.STAGE_UP, () => maybeAct({ type: E.PET.STAGE_UP }));
  }
}

// 判断此刻是否应主动开口并返回 { shouldAct, line }；同时做冷却/概率/随机选句。
// 不真正 say（有 side effect 的动作由调用方根据 shouldAct 执行），保证可测。
function consider({ type, state, now = nowFn() } = {}) {
  const t = now;
  const trigger = TRIGGERS[type];
  const forced = type === E.PET.STAGE_UP;
  // 全局冷却：非强制触发受约束；STAGE_UP 晋升值得及时庆祝，允许突破冷却
  if (!forced && t - lastSay < GLOBAL_COOLDOWN_MS) return { shouldAct: false };
  let lines = [];
  if (trigger) {
    // 同类冷却（STAGE_UP 无同类限制）
    if (forced) lines = trigger.lines;
    else if (lastKind[type] && t - lastKind[type] < trigger.cooldownMs) return { shouldAct: false };
    else lines = trigger.lines;
  } else {
    // 状态阈值触发
    const st = state || {};
    const cands = stateLines(st, t);
    for (const c of cands) {
      const k = `state:${c.key}`;
      if (t - (lastKind[k] || 0) >= SAME_KIND_COOLDOWN_MS) {
        lines = c.lines;
        break;
      }
    }
    if (!lines.length) return { shouldAct: false };
  }
  // 概率：若非强制触发，给点随机性
  if (!forced && Math.random() > chance) return { shouldAct: false };
  // 随机选一句
  const line = lines[Math.floor(Math.random() * lines.length)] || '';
  if (!line) return { shouldAct: false };
  if (!forced) {
    lastKind[type || `state:${type}`] = t;
  }
  return { shouldAct: true, line };
}

// 行动入口：consider 通过则真正调用 say（供 main 装配调用）。
function maybeAct({ type, state, now }) {
  const at = now || nowFn();
  // 先检查用户边界，避免静音/安静时段里的触发消耗冷却或每日配额。
  if (policy && !policy.allows(at)) return '';
  const r = consider({ type, state, now: at });
  if (r.shouldAct && say) {
    if (policy && !policy.reserve(at)) return '';
    lastSay = at;
    try { say(r.line); } catch { /* 行动失败不致命 */ }
    return r.line;
  }
  return '';
}

// 测试工具
function _setNow(fn) { nowFn = fn || (() => Date.now()); }
function _setChance(v) { chance = v; }
function _reset() {
  bus = null;
  say = null;
  lastSay = 0;
  lastKind = {};
  chance = CHANCE;
  nowFn = () => Date.now();
  policy = null;
}

module.exports = { init, consider, maybeAct, _setNow, _setChance, _reset };
