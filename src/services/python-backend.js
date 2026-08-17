// Python Companion Core 的本地 JSON-RPC 桥。
// Electron 继续拥有窗口、权限和 IPC；Python 只处理受控领域状态。
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const APP_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_SCRIPT = path.join(APP_ROOT, 'companion-core', 'server.py');
const START_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

function toError(value, fallback = 'Python 后端请求失败') {
  if (value instanceof Error) return value;
  return new Error(String(value || fallback));
}

class PythonBackendBridge extends EventEmitter {
  constructor({ python, script, env, startTimeoutMs } = {}) {
    super();
    this.python = python || process.env.MIRAI_BACKEND_PYTHON || 'python3';
    this.script = script || DEFAULT_SCRIPT;
    this.extraEnv = env || {};
    this.startTimeoutMs = startTimeoutMs || START_TIMEOUT_MS;
    this.child = null;
    this.ready = false;
    this.pending = new Map();
    this.sequence = 0;
    this.startPromise = null;
    this.queuedEvent = null;
  }

  getStatus() {
    return {
      running: Boolean(this.child),
      ready: this.ready,
      pending: this.pending.size,
      script: this.script,
    };
  }

  start({ dataDir } = {}) {
    if (this.ready) return Promise.resolve(this.getStatus());
    if (this.startPromise) return this.startPromise;
    if (!dataDir || typeof dataDir !== 'string') return Promise.reject(new TypeError('Python 后端需要 dataDir'));

    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(value);
      };
      const timeout = setTimeout(() => {
        this.stop();
        finish(reject, new Error('Python 后端启动超时'));
      }, this.startTimeoutMs);

      try {
        this.child = spawn(this.python, [this.script], {
          env: { ...process.env, ...this.extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(reject, error);
        return;
      }

      this.child.once('error', (error) => {
        this._handleExit(error);
        finish(reject, error);
      });
      this.child.once('exit', (code, signal) => {
        const error = new Error(`Python 后端已退出（code=${code ?? 'null'} signal=${signal || 'none'}）`);
        this._handleExit(error);
        if (!this.ready) finish(reject, error);
      });
      this.child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk).trim()));
      const lines = readline.createInterface({ input: this.child.stdout });
      lines.on('line', (line) => this._handleLine(line));

      this.request('core.bootstrap', { dataDir }).then(async () => {
        this.ready = true;
        const latest = this.queuedEvent;
        this.queuedEvent = null;
        if (latest) await this.ingest(latest);
        finish(resolve, this.getStatus());
      }).catch((error) => {
        this.stop();
        finish(reject, error);
      });
    }).finally(() => { this.startPromise = null; });

    return this.startPromise;
  }

  request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Python 后端未运行'));
    }
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method 必须是非空字符串'));
    const id = `node:${++this.sequence}`;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Python 后端请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${message}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ingest(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event 必须是对象');
    if (!this.ready) {
      this.queuedEvent = event; // 未就绪时只保留最新低频观察，避免积压敏感上下文。
      return { accepted: false, queued: true };
    }
    return this.request('event.ingest', { event });
  }

  snapshot() {
    return this.request('core.snapshot');
  }

  async stop() {
    const child = this.child;
    this.ready = false;
    this.queuedEvent = null;
    if (!child) return;
    // 在清空 this.child 前发送 shutdown，避免退出时把仍存活的子进程留在后台。
    try { await this.request('core.shutdown', {}, { timeoutMs: 800 }); } catch {/* force-stop below */}
    if (this.child === child) this.child = null;
    try { child.kill('SIGTERM'); } catch {/* already exited */}
  }

  _handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.emit('protocol-error', new Error('Python 后端返回了非 JSON 数据'));
      return;
    }
    if (!message || typeof message.id !== 'string') {
      this.emit('protocol-error', new Error('Python 后端返回缺少 id'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(toError(message.error?.message || message.error));
  }

  _handleExit(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.ready = false;
    this.child = null;
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(toError(error));
    }
    this.emit('exit', toError(error));
  }
}

module.exports = function createPythonBackend(options) {
  return new PythonBackendBridge(options);
};
module.exports.PythonBackendBridge = PythonBackendBridge;
