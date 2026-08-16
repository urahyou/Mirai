// 自写日记系统（P1）。
//
// 让 小未来 自己记下每一天：订阅 eventBus 的互动/感知事件（对话/点击/冷落/深夜/连用/晋升等），
// 到自然日切换时（或应用退出时）把当天的事件 + 当天 pet 状态快照，落盘为一篇 markdown 日记。
//
// 设计要点（与全项目哲学一致）：
// - 按自然日期惰性落盘：不改日期不写；检测到当前墙钟日期 ≠ 记录日期时才 close 上一页。
// - 进行中的当天 buffer 持久化到 .journal-state.json，崩溃/重启不丢（同一天继续累积）。
// - 不依赖 LLM（离线稳定），模板生成；日后可接 LLM 增强叙事。
// - 时钟 / 存储目录 / petState / eventBus 全部可注入，纯可测。

const fs = require('fs');
const path = require('path');
const E = require('../contracts/events');

let dir = '';            // userData 目录（journals/ 与 .journal-state.json 放在其下）
let petState = null;
let bus = null;
let nowFn = () => new Date();
let currentDate = null;  // 'YYYY-MM-DD'
let buffer = [];         // 当天事件 [{t, type}]

const EVENT_LABEL = {
  [E.PET.CONVERSATION]: '和你聊了会天',
  [E.PET.GREETING]: '你轻轻摸了摸我',
  [E.PET.NEGLECT]: '被冷落了一阵',
  [E.PET.LATE_NIGHT]: '陪我熬到深夜',
  [E.PET.LONG_SESSION]: '陪我长时间一起待着',
  [E.PET.STAGE_UP]: '进阶啦',
  [E.PET.PRAISE]: '被你夸了',
  [E.PET.FEED]: '被你投喂啦',
};

function p2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function fmtTime(ms) { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }

const STATE_FILE = '.journal-state.json';
function statePath() { return path.join(dir, STATE_FILE); }
function loadState() {
  try {
    if (fs.existsSync(statePath())) {
      const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      return { currentDate: s.currentDate || null, buffer: Array.isArray(s.buffer) ? s.buffer : [] };
    }
  } catch {}
  return null;
}
function saveState() {
  if (!dir) return;
  try {
    if (!currentDate && buffer.length === 0) {
      if (fs.existsSync(statePath())) fs.unlinkSync(statePath());
      return;
    }
    fs.writeFileSync(statePath(), JSON.stringify({ currentDate, buffer }, null, 2));
  } catch {}
}

function summary(counts, st) {
  const conv = counts[E.PET.CONVERSATION] || 0;
  const greet = counts[E.PET.GREETING] || 0;
  const neg = counts[E.PET.NEGLECT] || 0;
  const parts = [];
  if (conv) parts.push(`和你聊了 ${conv} 次天`);
  if (greet) parts.push(`被你轻轻摸了摸 ${greet} 次`);
  if (!parts.length && !neg) parts.push('今天只是静静地陪在主人身边');
  const moodNote = st ? `\n\n${st}` : '';
  return `${parts.join('，')}。${neg ? `\n\n（中间有一阵子没见到主人，有点想你呢。）` : ''}${moodNote}`;
}

function buildEntry(date, events) {
  const st = petState && typeof petState.describe === 'function' ? petState.describe() : '';
  const counts = {};
  const lines = [];
  for (const e of events) {
    const lbl = EVENT_LABEL[e.type] || e.type;
    counts[e.type] = (counts[e.type] || 0) + 1;
    lines.push(`- ${fmtTime(e.t)} ${lbl}`);
  }
  return [
    `# 小未来日记 · ${date}`,
    '',
    '> 由我亲手记下这一天。',
    '',
    '## 今日小结',
    summary(counts, st),
    '',
    '## 今天发生了什么',
    lines.length ? lines.join('\n') : '- （今天还没有值得记的事）',
    '',
    '',
  ].join('\n');
}

// 把 buffer 落盘为某天的 markdown（不清理 buffer；可在同一天重复写、幂等覆盖）。
function flushDay(date) {
  if (!dir) return false;
  const events = buffer.filter((e) => dateStr(new Date(e.t)) === date);
  const jdir = path.join(dir, 'journals');
  fs.mkdirSync(jdir, { recursive: true });
  fs.writeFileSync(path.join(jdir, `${date}.md`), buildEntry(date, events));
  return true;
}

// 检查日期是否切换；切换则 close 上一页并开新页。
function reconcile(now) {
  now = now || nowFn();
  const today = dateStr(now);
  if (currentDate && currentDate !== today) {
    flushDay(currentDate);
    buffer = [];
    currentDate = today;
  }
  if (!currentDate) currentDate = today;
}

function onEvent(type) {
  const now = nowFn();
  reconcile(now);
  buffer.push({ t: now.getTime(), type });
  saveState();
}

function init({ eventBus, petState: ps, dir: d, now } = {}) {
  dir = d || '';
  if (ps) petState = ps;
  if (now) nowFn = now;
  const s = loadState();
  currentDate = s ? s.currentDate : null;
  buffer = s && s.buffer ? s.buffer : [];
  bus = eventBus || null;
  if (bus) {
    for (const type of Object.values(E.PET)) bus.on(type, () => onEvent(type));
  }
}

// 应用退出收尾：把当前进行中的一天也落盘（幂等）。
function flush() {
  if (currentDate) flushDay(currentDate);
  saveState();
}

// 供测试/工具
function _reset() {
  dir = ''; petState = null; bus = null;
  nowFn = () => new Date(); currentDate = null; buffer = [];
}
function _state() { return { currentDate, buffer: [...buffer] }; }

module.exports = { init, reconcile, flush, onEvent, _reset, _state, _setNow: (fn) => { nowFn = fn; }, _dir: () => dir };
