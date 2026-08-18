const { execFile } = require('child_process');

const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const PERMISSION_ERROR = /not authorized|assistive access|permission|不允许|权限/i;
const FRONTMOST_SCRIPT = "tell application \"System Events\" to get name of first process whose frontmost is true";

function classify(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!value) return { category: 'unknown', activity: '状态未知' };
  if (/(code|xcode|terminal|iterm|warp|cursor|vim|emacs|sublime|android studio)/.test(value)) return { category: 'coding', activity: '专注工作' };
  if (/(word|pages|numbers|excel|powerpoint|notion|obsidian|typora|textedit|preview)/.test(value)) return { category: 'writing', activity: '阅读或编辑' };
  if (/(safari|chrome|edge|firefox|arc|brave)/.test(value)) return { category: 'browser', activity: '浏览网页' };
  if (/(slack|discord|wechat|微信|messages|telegram|qq)/.test(value)) return { category: 'communication', activity: '与人交流' };
  if (/(music|spotify|网易云|youtube|vlc)/.test(value)) return { category: 'media', activity: '观看或听音乐' };
  if (/(steam|game|游戏)/.test(value)) return { category: 'game', activity: '休闲娱乐' };
  return { category: 'other', activity: '使用电脑' };
}

function defaultObserve() {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', FRONTMOST_SCRIPT], { timeout: 3000 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout || '').trim());
    });
  });
}

module.exports = function createScreenSense({ observe = defaultObserve, now = () => Date.now(), pollMs = DEFAULT_POLL_MS } = {}) {
  let enabled = false;
  let ttlMs = DEFAULT_TTL_MS;
  let timer = null;
  let starting = false;
  let generation = 0;
  let permission = 'unknown';
  let snapshot = { category: null, activity: null, updatedAt: null };

  function clear() {
    generation += 1;
    snapshot = { category: null, activity: null, updatedAt: null };
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) { stop(); clear(); }
  }

  function setTtl(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) ttlMs = Math.max(30000, Math.min(86400000, Math.round(parsed)));
  }

  function isRunning() { return Boolean(timer || starting); }
  function isAvailable() { return process.platform === 'darwin'; }
  function getPermissionStatus() { return permission; }
  function isFresh() { return Number.isFinite(snapshot.updatedAt) && now() - snapshot.updatedAt < ttlMs; }

  function getSnapshot() {
    if (!isFresh()) return { category: null, activity: null, updatedAt: snapshot.updatedAt, stale: Boolean(snapshot.updatedAt) };
    return { ...snapshot, stale: false };
  }

  function getAwareness() {
    const current = getSnapshot();
    return current.activity ? `屏幕：${current.activity}` : '';
  }

  async function poll() {
    if (!enabled) return getSnapshot();
    const generationAtStart = generation;
    let appName;
    try {
      appName = await observe();
      permission = 'granted';
    } catch (error) {
      permission = PERMISSION_ERROR.test(String(error?.message || error)) ? 'denied' : 'unknown';
      if (permission === 'denied') stop();
      return getSnapshot();
    }
    if (!enabled || generationAtStart !== generation) return getSnapshot();
    const semantic = classify(appName);
    snapshot = { ...semantic, updatedAt: now() };
    return getSnapshot();
  }

  function start() {
    if (!isAvailable() || !enabled || timer || starting) return;
    starting = true;
    void poll().then(() => {
      starting = false;
      if (enabled && permission !== 'denied' && !timer) timer = setInterval(() => { void poll(); }, pollMs);
    }).catch(() => { starting = false; });
  }

  return { start, stop, poll, clear, setEnabled, setTtl, isRunning, isAvailable, getPermissionStatus, getSnapshot, getAwareness };
};

module.exports.classify = classify;
