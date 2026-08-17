// Mirai 语音桥 —— 管理 Python 侧车子进程 + WebSocket 音频/识别通道
// main 进程专用。负责：
//   - 拉起/守护 voice-sidecar/sidecar_server.py
//   - 把 renderer 采集的 int16 PCM 转发给侧车
//   - 接收侧车的 vad/asr 消息，转发为事件（'vad' / 'asr'）
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

const SIDECAR_SCRIPT = path.join(__dirname, '..', '..', 'voice-sidecar', 'sidecar_server.py');
const SIDECAR_ROOT = path.join(__dirname, '..', '..', 'voice-sidecar');
// Mirai 自建独立 venv（voice-sidecar/.venv，全新环境一次配置）
const PYTHON = process.env.MIRAI_SIDECAR_PYTHON || path.join(SIDECAR_ROOT, '.venv', 'bin', 'python3');
const PORT = Number(process.env.MIRAI_SIDECAR_PORT || 8765);

// 从项目根 .env 读取所有 SIDECAR_* / MIRAI_SIDECAR_* 键，透传给侧车子进程。
// 这样用户改 .env 就能切 TTS 引擎/音色/URL，无需手动 export 到 shell。
// 解析统一走 services/dotenv.js（单一事实源）。
const dotenv = require('../services/dotenv');
function loadSidecarDotEnv() {
  const extra = {};
  const all = dotenv.readAll();
  for (const [k, v] of Object.entries(all)) {
    if (/^(SIDECAR_|MIRAI_SIDECAR_)/.test(k)) extra[k] = v;
  }
  return extra;
}

// 未就绪期间最多缓存 ~5 秒 PCM（约 1200 块 * 4096 样本 * 2 字节）
const MAX_PCM_QUEUE = 1200;
const RESTART_DELAY_MS = 2000;

// 回收侧车端口：上次进程被强杀（SIGKILL）或父进程崩溃时，Python sidecar 会
// 变成孤儿（PPID→1）常驻占用 8765。若不先清理，新拉起的 sidecar 会 bind 失败
// （Errno 48 / address already in use）并触发无限重试。
// 8765 仅由本项目 sidecar 使用，这里按监听 PID 安全回收。
function reclaimSidecarPort() {
  try {
    const out = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const seen = new Set();
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      const n = Number(pid);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        try { process.kill(n, 'SIGTERM'); } catch {/* 进程可能已退出 */}
      }
    }
  } catch {/* 端口空闲，无需回收 */}
}

// 杀掉 8765 监听者后，轮询等待端口真正释放再让新 sidecar 去 bind，
// 避免旧进程刚收 SIGTERM 还没关闭 socket（TIME_WAIT）时新进程 bind 报 Errno 48。
// 返回 true=可 bind；false=超时（仍尝试，靠 scheduleRestart 自动重试兑底）。
function waitPortFree(timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (!String(out).trim()) return true; // 己无监听者 = 端口空闲
    } catch {
      return true; // lsof 找不到监听者即视为空闲
    }
    try { execSync('sleep 0.2'); } catch {/* noop */}
  }
  return false;
}

class VoiceBridge extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.ws = null;
    this.ready = false;
    this.connecting = false;
    this.pcmQueue = [];
    this.speakQueue = [];
    this.speakSequence = 0;
    this.speakStartedAt = new Map();
    this.restartTimer = null;
    this.retryTimer = null;
  }

  start() {
    // 禁用语音：MIRAI_VOICE_DISABLE=1 时不拉起侧车（测试/CI 用，加快进场、省 CPU）
    if (['1', 'true', 'yes', 'on'].includes(String(process.env.MIRAI_VOICE_DISABLE || '').toLowerCase())) {
      console.log('[voice] MIRAI_VOICE_DISABLE=1，跳过语音侧车启动');
      return this;
    }
    if (this.child || this.connecting) return this;
    this.spawnSidecar();
    this.connect();
    return this;
  }

  spawnSidecar() {
    reclaimSidecarPort(); // 先清掉常驻的孤儿 sidecar，确保能绑定到 8765
    waitPortFree();       // 再等端口真正释放，避免 bind 竞态（Errno 48）
    this.child = spawn(PYTHON, [SIDECAR_SCRIPT], {
      env: {
        ...process.env,
        ...loadSidecarDotEnv(), // .env 里的 SIDECAR_* 优先生效
        SIDECAR_PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d) => console.log(`[sidecar] ${String(d).trim()}`));
    this.child.stderr.on('data', (d) => console.warn(`[sidecar:err] ${String(d).trim()}`));
    this.child.on('exit', (code, signal) => {
      console.log(`[sidecar] exited (code=${code}, signal=${signal})`);
      if (this.child) {
        this.child = null;
        this.ws = null;
        this.ready = false;
        this.scheduleRestart();
      }
    });
  }

  scheduleRestart() {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.child) this.spawnSidecar();
      if (!this.ws) this.connect();
    }, RESTART_DELAY_MS);
  }

  connect() {
    if (this.connecting || this.ws) return;
    this.connecting = true;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.connecting = false;
      this.flushQueue();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onerror = () => {
      this.connecting = false;
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.connecting = false;
      this.ready = false;
      this.emit('ready-change', false);
      // 侧车可能还没起来（connection refused），自动重试连接
      this.retryConnect();
    };
  }

  retryConnect() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.ws && this.child) this.connect();
    }, 1000);
  }

  handleMessage(data) {
    if (typeof data !== 'string') return;
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ready') {
        this.ready = true;
        console.log('[voice] sidecar ready');
        this.emit('ready-change', true);
      } else if (msg.type === 'asr') {
        const text = String(msg.text || '').trim();
        if (!text) return;
        if (msg.partial) this.emit('asr-partial', text);
        else this.emit('asr', text);
      } else if (msg.type === 'vad') {
        this.emit('vad', msg.state);
      } else if (msg.type === 'audio') {
        // 侧车合成的语音（base64 MP3）→ 解码为 Buffer 交还上层播放
        const data = Buffer.from(msg.data || '', 'base64');
        const startedAt = this.speakStartedAt.get(msg.id);
        this.speakStartedAt.delete(msg.id);
        if (data.length) this.emit('audio', {
          id: msg.id,
          format: msg.format || 'mp3',
          data,
          ttsMs: Number(msg.ttsMs) || null,
          latencyMs: startedAt ? Date.now() - startedAt : null,
        });
      }
    } catch {/* 忽略非 JSON */}
  }

  sendPcm(buf) {
    const value = toArrayBuffer(buf);
    if (!value) return;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.pcmQueue.length < MAX_PCM_QUEUE) this.pcmQueue.push(value);
      this.connect();
      return;
    }
    this.ws.send(value);
  }

  // 让小未来开口：把要朗读的文字交给侧车合成语音
  speak(text, id = null) {
    const value = String(text || '').trim().slice(0, 2000);
    if (!value) return;
    const requestId = id === null ? ++this.speakSequence : id;
    this.speakStartedAt.set(requestId, Date.now());
    const wire = JSON.stringify({ type: 'speak', text: value, id: requestId });
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 未就绪：只保留最新一条待读文本，避免就绪后一次性 flush 堆积
      this.speakQueue.length = 0;
      this.speakQueue.push(wire);
      this.connect();
      return;
    }
    this.ws.send(wire);
  }

  flushQueue() {
    const q = this.pcmQueue;
    this.pcmQueue = [];
    for (const b of q) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(b);
    }
    const s = this.speakQueue;
    this.speakQueue = [];
    for (const wire of s) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(wire);
    }
  }

  getStatus() {
    return { running: Boolean(this.child), connected: this.ready, port: PORT, queued: this.pcmQueue.length };
  }

  // 返回 .env 里全部 SIDECAR_* 透传键（供 main 判断是否需要“外语朗读”翻译）
  getSidecarEnv() {
    return loadSidecarDotEnv();
  }

  // 重启侧车：让改动后的 .env（如 TTS 引擎/合成语言/参考音频）立即生效。
  restart() {
    const wasRunning = Boolean(this.child);
    this.stop(); // stop() 只发 SIGTERM，旧进程释放 8765 需要一点时间
    if (!wasRunning) return this;
    // 延迟再起，避免旧进程端口未释放时新进程 bind 报 Errno 48（address already in use）
    setTimeout(() => {
      if (!this.child) this.spawnSidecar();
      if (!this.ws) this.connect();
    }, RESTART_DELAY_MS);
    return this;
  }

  stop() {
    try { this.ws?.close(); } catch {/* noop */}
    this.ws = null;
    this.ready = false;
    try { this.child?.kill('SIGTERM'); } catch {/* noop */}
    this.child = null;
    this.pcmQueue = [];
    this.speakQueue = [];
    this.speakStartedAt.clear();
  }
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  if (ArrayBuffer.isView(buf)) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  return null;
}

module.exports = new VoiceBridge();
