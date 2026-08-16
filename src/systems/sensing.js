// 感知系统：让 pet-state 开始"感知"真实世界（自主体 P0-3，最小起点）。
//
// 只做一件事：把真实时钟/系统状态轮询成"语境事件"，喂给 pet-state。
// - 心跳周期性发 `sensing:tick`（其他感知源/系统可订阅）
// - 由墙钟推断语境并推导 pet 事件：
//     * 深夜(23:00–05:00) → LATE_NIGHT（每日首次进入夜晚触发一次）
//     * 连续在线超过阈值 → LONG_SESSION（每隔一段时间重触发）
//     * 距最后一次互动超阈值 → NEGLECT（每隔一段时间提醒一次）
// - 触发节流：同一语境不重复轰炸，防刷状态。
//
// 纯逻辑、时钟/存储可注入（测试用）。生命周期 start/stop 由 main 装配。

const storage = require('../services/storage');
const E = require('../contracts/events');
const petState = require('../systems/pet-state');

const SCHEMA_KEY = 'sensing_state';
const SCHEMA_VERSION = 1;
const DEFAULT_STATE = Object.freeze({
  lastLateNightDay: '',   // 最近一次触发深夜的日期
  lastLongSessionAt: null, // 最近一次触发连用的时间戳
  lastNeglectAt: null,     // 最近一次触发冷落的时间戳
});

const MS_HOUR = 3600 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000; // 心跳间隔 60s

// 语境判定阈值（默认，后续可在面板/配置上调）
const LATE_NIGHT_START_H = 23; // 深夜开始（含）
const LATE_NIGHT_END_H = 5;    // 深夜结束（不含）
const LONG_SESSION_MIN_HOURS = 6;  // 连续在线多久算"连用"
const LONG_SESSION_REPEAT_HOURS = 6; // 连用重触发的间隔
const NEGLECT_MIN_HOURS = 24;   // 距最后互动多久算"冷落"
const NEGLECT_REPEAT_HOURS = 24;// 冷落提醒的间隔

let bus = null;
let timer = null;
let sessionStartAt = null; // 本次进程启动（首个 tick）时刻，供连用判断
let nowFn = () => Date.now();

function dayOf(ts) {
  const dt = new Date(ts);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function readState() {
  const doc = storage.read(SCHEMA_KEY);
  return doc && typeof doc === 'object' ? doc : { ...DEFAULT_STATE };
}

// 深夜判断：23:00 ≤ h 或 h < 05:00
function isLateNight(now) {
  const h = new Date(now).getHours();
  return h >= LATE_NIGHT_START_H || h < LATE_NIGHT_END_H;
}

function checkLateNight(now) {
  if (!isLateNight(now)) return;
  const st = readState();
  const today = dayOf(now);
  if (st.lastLateNightDay === today) return; // 当天已触发过
  petState.applyEvent(E.PET.LATE_NIGHT);
  storage.write(SCHEMA_KEY, { ...st, lastLateNightDay: today });
}

function checkLongSession(now) {
  if (!sessionStartAt) return;
  const elapsedH = (now - sessionStartAt) / MS_HOUR;
  if (elapsedH < LONG_SESSION_MIN_HOURS) return;
  const st = readState();
  const last = st.lastLongSessionAt || 0;
  if (now - last < LONG_SESSION_REPEAT_HOURS * MS_HOUR) return; // 节流
  petState.applyEvent(E.PET.LONG_SESSION);
  storage.write(SCHEMA_KEY, { ...st, lastLongSessionAt: now });
}

function checkNeglect(now) {
  const s = petState.getState();
  const lastInt = s.affection.lastInteractionAt;
  if (!lastInt) return; // 从未互动过，不算冷落
  const idleH = (now - lastInt) / MS_HOUR;
  if (idleH < NEGLECT_MIN_HOURS) return;
  const st = readState();
  const last = st.lastNeglectAt || 0;
  if (now - last < NEGLECT_REPEAT_HOURS * MS_HOUR) return; // 节流
  petState.applyEvent(E.PET.NEGLECT);
  storage.write(SCHEMA_KEY, { ...st, lastNeglectAt: now });
}

// 单个心跳：广播 tick 并推导语境事件
function tick(now = nowFn()) {
  bus.emit(E.SENSING_TICK, { now });
  checkLateNight(now);
  checkLongSession(now);
  checkNeglect(now);
}

function start({ intervalMs } = {}) {
  if (timer) return; // 已启动
  if (!sessionStartAt) sessionStartAt = nowFn();
  timer = setInterval(() => tick(), intervalMs || DEFAULT_INTERVAL_MS);
  tick(); // 启动即先跑一拍
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function isRunning() { return !!timer; }

// 初始化：注册 schema + 注入事件总线（main 装配时调用）
function init({ eventBus } = {}) {
  bus = eventBus || null;
  storage.register(SCHEMA_KEY, {
    version: SCHEMA_VERSION,
    defaults: DEFAULT_STATE,
    migrations: {},
    normalize: (raw) => ({ ...DEFAULT_STATE, ...(raw && typeof raw === 'object' ? raw : {}) }),
  });
}

// 测试工具
function _setNow(fn) {
  nowFn = fn || (() => Date.now());
  sessionStartAt = null;
}
function _reset() {
  bus = null;
  timer = null;
  sessionStartAt = null;
  nowFn = () => Date.now();
}
// 测试：手动把本次会话起点推到过去（模拟连续在线很久）
function _setSessionStartAt(ts) { sessionStartAt = ts; }

module.exports = { init, start, stop, isRunning, tick, isLateNight, _setNow, _reset, _setSessionStartAt };
