// 系统状态感知（P1 延续）。
//
// 让 小未来能感知“主人的电脑此刻的状态”：电池电量/是否充电、是否联网、当前时刻，
// 汇聚成一句自然语言意识（getAwareness()），注入对话 system prompt，
// 使发言能贴合现实（如电量告急时提醒、联网时活跃、深夜安静等）。
//
// 设计要点：
// - 采集器（battery/network）全部可注入，默认实现用 `pmset -g batt` 与 icmp ping；
//   测试注入假采集器即可，不依赖真实硬件/网络。
// - 轮询周期可配（默认 5min）；start/stop 随应用启停；快照带 updatedAt。
// - getAwareness() 纯字符串拼接，非 LLM，离线稳定、可测。

const os = require('os');
const { execFile } = require('child_process');

let batteryP = defaultBattery;
let networkP = defaultNetwork;
let nowFn = () => Date.now();
let pollMs = 5 * 60 * 1000;
let timer = null;
let snapshot = { battery: { level: null, charging: null }, online: null, updatedAt: null, idleSince: null };

// —— 默认采集器（macOS）——

// pmset -g batt 输出形如： "Now drawing from 'Battery Power' -InternalBattery-0 (id=...) 78%; discharging;"
function defaultBattery() {
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'batt'], (err, out) => {
      if (err || !out) return resolve({ level: null, charging: null });
      const m = String(out).match(/(\d+)%;\s*(\S+)/i);
      if (!m) return resolve({ level: null, charging: null });
      const state = String(m[2] || '').toLowerCase();
      resolve({ level: parseInt(m[1], 10), charging: state.includes('charging') && !state.includes('not charging') });
    });
  });
}

// icmp ping 一个内网/公网网关探测联网（超时 1s；ping 被禁时视为未知而非离线告警）。
function defaultNetwork() {
  return new Promise((resolve) => {
    const host = '192.168.1.1';
    execFile('ping', ['-c', '1', '-W', '1000', host], (err) => resolve(err ? false : true));
  });
}

// —— 汇聚 ——

function timeOfDay(h) {
  if (h < 5) return '深夜';
  if (h < 8) return '清晨';
  if (h < 12) return '上午';
  if (h < 13) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

function formatLocalClock(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}（${zone}）`;
}

async function poll() {
  try { snapshot.battery = await batteryP(); } catch { snapshot.battery = { level: null, charging: null }; }
  try { snapshot.online = await networkP(); } catch { snapshot.online = null; }
  snapshot.updatedAt = nowFn();
}

function start() {
  if (timer) return;
  void poll();
  timer = setInterval(() => { void poll(); }, pollMs);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

// 一句自然语言：此刻时刻 + 电量 + 联网状态
function getAwareness() {
  const timestamp = nowFn();
  const h = new Date(timestamp).getHours();
  // 给模型准确的本机钟点，避免仅凭“中午/下午”自行猜测具体时间。
  const parts = [`此刻本机时间：${formatLocalClock(timestamp)}`, `时段：${timeOfDay(h)}`];
  const b = snapshot.battery;
  if (b && typeof b.level === 'number') {
    parts.push(`电量 ${b.level}%${b.charging ? '（充电中）' : ''}`);
  }
  parts.push(snapshot.online === false ? '未联网' : '联网正常');
  return parts.join('；');
}

function getSnapshot() { return { ...snapshot, battery: { ...snapshot.battery } }; }

function init({ battery, network, now, pollMs: ms } = {}) {
  if (battery) batteryP = battery;
  if (network) networkP = network;
  if (now) nowFn = now;
  if (ms) pollMs = ms;
}

function _reset() {
  batteryP = defaultBattery; networkP = defaultNetwork;
  nowFn = () => Date.now(); pollMs = 5 * 60 * 1000; timer = null;
  snapshot = { battery: { level: null, charging: null }, online: null, updatedAt: null, idleSince: null };
}

module.exports = { init, start, stop, poll, getAwareness, getSnapshot, timeOfDay, formatLocalClock, _reset };
