// memU 记忆侧车环境变量服务：读写项目根 .env 里的 MEMU_* 键。
// memU（NevaMind-AI/memU）是一个轻量本地记忆系统：SQLite 存储 + OpenAI 兼容 embedding。
// 本模块让 Mirai 用 .env 配置 memU，避开云端，保持数据在本机。
//
// 默认方案（已验证）：
//   - MEMU_EMBED_PROVIDER=openai  -> memU 用 openai 兼容协议，但 base_url 指向本机 Ollama
//   - MEMU_BASE_URL=http://127.0.0.1:11434/v1  -> 本机 Ollama 的 OpenAI 兼容端点
//   - MEMU_EMBED_MODEL=bge-m3      -> 本地中文/多语言 embedding（区分度远好于 nomic-embed-text）
//   - MEMU_DB=sqlite:///<userData>/memu.sqlite3 -> 本地记忆库
//   - MEMU_RELEVANCE_THRESHOLD=0.5 -> 检索相关性阈值（过滤无关记忆）
const fs = require('fs');
const path = require('path');

const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');

// userData 目录（与 Electron app.getPath('userData') 一致，package.json name=haruhana-quest）
function userDataPath() {
  return process.env.MIRAI_USER_DATA || path.join(process.env.HOME || '', 'Library', 'Application Support', 'haruhana-quest');
}

function dbDsn() {
  return `sqlite:///${path.join(userDataPath(), 'memu.sqlite3')}`;
}

const DEFAULTS = Object.freeze({
  MEMU_ENABLED: 'true',
  MEMU_EMBED_PROVIDER: 'openai',
  MEMU_BASE_URL: 'http://127.0.0.1:11434/v1',
  MEMU_EMBED_MODEL: 'bge-m3',
  MEMU_DB: dbDsn(),
  MEMU_API_KEY: '',
  MEMU_RELEVANCE_THRESHOLD: '0.5',
  MEMU_MAX_RESULTS: '5',
  MEMU_DISTILL_PROVIDER: '', // 记忆提炼 provider 名（已声明，现由 BASE_URL+MODEL 表达，见下）
  MEMU_DISTILL_BASE_URL: '', // 记忆提炼专用后端（留空=跟随对话 activeProvider）
  MEMU_DISTILL_MODEL: '', // 记忆提炼专用本地小模型（如 qwen3:8b；需配合 BASE_URL）
});

function readRaw() {
  try {
    return fs.readFileSync(DOTENV_PATH, 'utf8');
  } catch {
    return '';
  }
}

function read() {
  const out = { ...DEFAULTS };
  // 优先级：process.env > .env 文件 > 默认值
  for (const raw of readRaw().split(/\r?\n/)) {
    const m = raw.match(/^\s*(MEMU_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] in out) out[m[1]] = m[2];
  }
  for (const key of Object.keys(out)) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

// 更新 .env 中的 MEMU_* 键（只改写已存在行、保留注释；新增键追加到末尾）
function write(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch 必须是对象');
  const sanitized = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!/^MEMU_[A-Z0-9_]+$/.test(key)) continue;
    sanitized[key] = String(value ?? '').trim();
  }
  if (!Object.keys(sanitized).length) return read();
  const current = read();
  const next = { ...current, ...sanitized };
  const lines = readRaw().split(/\r?\n/);
  const present = new Set(Object.keys(sanitized).filter((k) => lines.some((l) => l.startsWith(`${k}=`))));
  const outLines = lines.map((l) => {
    for (const k of Object.keys(sanitized)) {
      if (l.startsWith(`${k}=`)) return `${k}=${next[k]}`;
    }
    return l;
  });
  for (const k of Object.keys(sanitized)) {
    if (!present.has(k)) outLines.push(`${k}=${next[k]}`);
  }
  fs.mkdirSync(path.dirname(DOTENV_PATH), { recursive: true });
  fs.writeFileSync(DOTENV_PATH, outLines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return read();
}

module.exports = { DEFAULTS, read, write, userDataPath, dbDsn };
