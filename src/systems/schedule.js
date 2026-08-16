// 日程提醒系统（P1）。
//
// 读取本地 `.ics` 日历文件（用户可自行放入 userData/schedule.ics），解析 VEVENT，
// 在事件临近/到点（leadMs 窗口内）触发一次提醒，通过 emit(text) 让小未来主动开口。
// 无 `.ics` 文件时优雅地原地待机（feature off），不影响其余功能。
//
// 设计要点：
// - ICS 文本 / 时钟 / 提醒回调 / 提醒集合持久化 全部可注入，纯可测。
// - 支持单次事件与基础 RRULE(FREQ=DAILY/WEEKLY with INTERVAL)。
// - 已提醒集合按 (uid+date) 去重，持久化到 storage（跨重启不重复提醒）。
// - 提醒走与 proactive 相同的 "say" 通道（朗读 + 宠物窗气泡）。

const DEFAULT_LEAD_MS = 10 * 60 * 1000; // 事件开始前多久算“临近”提醒

let storage = null;
let getIcs = () => '';        // () => string，返回 ICS 文本（可注入）
let nowFn = () => Date.now();
let leadMs = DEFAULT_LEAD_MS;
let emit = null;
let reminded = new Set();     // "uid@YYYYMMDD" 集合
let events = [];
let lastLoadMs = 0;
let timer = null;
let intervalMs = 30 * 1000;   // 每 30s 查一次提醒（低频，不影响负载）
const RELOAD_MIN = 60 * 1000; // 每分钟重读一次 .ics（用户改了文件也能感知）

// —— ICS 解析（最小可行实现）——

function parseIcs(text) {
  if (!text || typeof text !== 'string') return [];
  const unfolded = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const blocks = String(unfolded).split(/BEGIN:VEVENT/i).slice(1);
  const out = [];
  for (const b of blocks) {
    const end = b.indexOf('END:VEVENT');
    const body = end >= 0 ? b.slice(0, end) : b;
    const kv = {};
    for (const line of body.split('\n')) {
      const m = line.match(/^([^:;]+)(;[^:]*)?:(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const val = m[3].trim();
      if (key === 'DTSTART') kv.dtstart = val;
      else if (key === 'SUMMARY') kv.summary = val;
      else if (key === 'LOCATION') kv.location = val;
      else if (key === 'UID') kv.uid = val;
      else if (key === 'RRULE') kv.rrule = val;
    }
    if (!kv.dtstart) continue;
    const startMs = parseDateTime(kv.dtstart);
    if (startMs == null) continue;
    out.push({
      uid: kv.uid || `e${out.length}`,
      summary: kv.summary || '一项日程',
      location: kv.location || '',
      startMs,
      rrule: parseRrule(kv.rrule),
    });
  }
  return out;
}

// 解析 DTSTART：支持 20260815T090000Z(UTC) 与 20260815T090000(本地)。
function parseDateTime(s) {
  const m = String(s).replace(/^[^:]*:/, '').match(/^(\d{4})(\d{2})(\d{2})[T ](\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  return new Date(+y, +mo - 1, +d, +h, +mi, +(se || 0)).getTime();
}

function parseRrule(s) {
  if (!s) return null;
  const freq = (String(s).match(/FREQ=([A-Z]+)/i) || [])[1] || null;
  const interval = parseInt((String(s).match(/INTERVAL=(\d+)/i) || [])[1] || '1', 10);
  const until = (String(s).match(/UNTIL=(\S+)/i) || [])[1] || null;
  return { freq, interval: isNaN(interval) ? 1 : interval, until: until ? parseDateTime(until) : null };
}

// 事件在 fromMs 之后的最近一次开始时间（单次=原时间；DAILY/WEEKLY 按间隔推算）。
function nextOccurrence(ev, fromMs) {
  const r = ev.rrule;
  const dur = (r && r.freq === 'WEEKLY') ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
  if (!r || !r.freq) return ev.startMs >= fromMs ? ev.startMs : null;
  if (r.freq !== 'DAILY' && r.freq !== 'WEEKLY') return ev.startMs >= fromMs ? ev.startMs : null;
  let t = ev.startMs, k = 0;
  while (t < fromMs) { k += r.interval; t = ev.startMs + k * dur; }
  if (r.until && t > r.until) return null;
  return t;
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function loadEvents() {
  const t = nowFn();
  if (t - lastLoadMs >= RELOAD_MIN) {
    try { events = parseIcs(getIcs()); lastLoadMs = t; } catch { /* keep last known */ }
  }
  return events;
}

// —— 提醒逻辑 ——

// 返回本次应触发的提醒文案数组；内部去重 + 持久化已提醒。
function checkReminders(now) {
  const fired = [];
  const evs = loadEvents();
  for (const ev of evs) {
    const occ = nextOccurrence(ev, now - 1000); // 不看已过去的
    if (occ == null) continue;
    const delta = occ - now;
    if (delta < 0 || delta > leadMs) continue; // 非临近/已过
    const key = `${ev.uid}@${dayKey(occ)}`;
    if (reminded.has(key)) continue;
    reminded.add(key);
    const loc = ev.location ? `（${ev.location}）` : '';
    const hm = `${String(new Date(occ).getHours()).padStart(2, '0')}:${String(new Date(occ).getMinutes()).padStart(2, '0')}`;
    fired.push(`主人～快到时间啦：${hm} 有「${ev.summary}」${loc}，别忘了哦`);
  }
  if (fired.length) persistReminded();
  return fired;
}

function tick() {
  const now = nowFn();
  const fired = checkReminders(now);
  if (fired.length && emit) for (const f of fired) emit(f);
}

// —— 生命周期 ——

function persistReminded() { if (storage) try { storage.register('schedule-reminded', { keys: [...reminded] }); } catch {} }
function restoreReminded() { if (storage) try { const s = storage.read('schedule-reminded'); if (s && Array.isArray(s.keys)) reminded = new Set(s.keys); } catch {} }
function start() { if (timer) return; restoreReminded(); tick(); timer = setInterval(tick, intervalMs); }
function stop() { if (timer) { clearInterval(timer); timer = null; } }

function init({ storage: st, ics, now, lead = leadMs, onEmit, interval = intervalMs } = {}) {
  if (st) storage = st;
  if (ics) getIcs = ics;
  if (now) nowFn = now;
  if (typeof lead === 'number') leadMs = lead;
  if (onEmit) emit = onEmit;
  if (typeof interval === 'number') intervalMs = interval;
}

function _reset() {
  storage = null; getIcs = () => ''; nowFn = () => Date.now();
  leadMs = DEFAULT_LEAD_MS; emit = null; reminded = new Set();
  events = []; lastLoadMs = 0; timer = null; intervalMs = 30 * 1000;
}

module.exports = { init, start, stop, tick, checkReminders, parseIcs, parseDateTime, parseRrule, nextOccurrence, _reset };
