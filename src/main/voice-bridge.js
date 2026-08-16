// Mirai 语音桥 —— 管理 Python 侧车子进程 + WebSocket 音频/识别通道
// main 进程专用。负责：
//   - 拉起/守护 voice-sidecar/sidecar_server.py
//   - 把 renderer 采集的 int16 PCM 转发给侧车
//   - 接收侧车的 vad/asr 消息，转发为事件（'vad' / 'asr'）
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const SIDECAR_SCRIPT = path.join(__dirname, '..', '..', 'voice-sidecar', 'sidecar_server.py');
const WARASHI_ROOT = process.env.MIRAI_WARASHI_ROOT || '/Users/urahyou/Desktop/warashi';
const PYTHON = process.env.MIRAI_SIDECAR_PYTHON || path.join(WARASHI_ROOT, '.venv', 'bin', 'python3');
const PORT = Number(process.env.MIRAI_SIDECAR_PORT || 8765);

// 从项目根 .env 读取所有 SIDECAR_* / MIRAI_SIDECAR_* 键，透传给侧车子进程。
// 这样用户改 .env 就能切 TTS 引擎/音色/URL，无需手动 export 到 shell。
const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');
function loadSidecarDotEnv() {
  const extra = {};
  try {
    const text = fs.readFileSync(DOTENV_PATH, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*(SIDECAR_[A-Z0-9_]+|MIRAI_SIDECAR_[A-Z0-9_]+|MIRAI_WARASHI_[A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) extra[m[1]] = m[2];
    }
  } catch {/* .env 不存在时静默，用默认值 */}
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

class VoiceBridge extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.ws = null;
    this.ready = false;
    this.connecting = false;
    this.pcmQueue = [];
    this.speakQueue = [];
    this.restartTimer = null;
    this.retryTimer = null;
  }

  start() {
    if (this.child || this.connecting) return this;
    this.spawnSidecar();
    this.connect();
    return this;
  }

  spawnSidecar() {
    reclaimSidecarPort(); // 先清掉常驻的孤儿 sidecar，确保能绑定到 8765
    this.child = spawn(PYTHON, [SIDECAR_SCRIPT], {
      env: {
        ...process.env,
        ...loadSidecarDotEnv(), // .env 里的 SIDECAR_* 优先生效
        SIDECAR_PORT: String(PORT),
        WARASHI_ROOT,
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
        if (data.length) this.emit('audio', { id: msg.id, format: msg.format || 'mp3', data });
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
  speak(text, id = 0) {
    const value = String(text || '').trim().slice(0, 2000);
    if (!value) return;
    const wire = JSON.stringify({ type: 'speak', text: value, id });
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
    this.stop();
    if (wasRunning) this.start();
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
