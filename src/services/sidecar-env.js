// 语音侧车环境变量服务：读写项目根 .env 里的 SIDECAR_* 键。
// 单一事实源保持 .env（与 voice-bridge 透传给侧车的值一致），UI 面板通过这里改配置。
const fs = require('fs');
const path = require('path');

const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');

// 面板可控键的默认值（.env 里没写时用这里）
const DEFAULTS = Object.freeze({
  SIDECAR_TTS_ENGINE: 'edge',
  SIDECAR_TTS_URL: 'http://127.0.0.1:9880/',
  SIDECAR_TTS_REF_WAV: '',
  SIDECAR_TTS_PROMPT_TEXT: '',
  SIDECAR_TTS_PROMPT_LANG: 'zh',
  SIDECAR_TTS_TEXT_LANGUAGE: 'zh',
  SIDECAR_TTS_SPEAK_LANG: '',
  SIDECAR_TTS_TEMPERATURE: '0.9',
  SIDECAR_TTS_SPEED_FACTOR: '1.0',
});
const PANEL_KEYS = ['SIDECAR_TTS_ENGINE', 'SIDECAR_TTS_TEXT_LANGUAGE', 'SIDECAR_TTS_SPEAK_LANG'];

function readRaw() {
  try {
    return fs.readFileSync(DOTENV_PATH, 'utf8');
  } catch {
    return '';
  }
}

// 读取 .env 里的 SIDECAR_* 值（与默认值合并）
function read() {
  const out = { ...DEFAULTS };
  for (const raw of readRaw().split(/\r?\n/)) {
    const m = raw.match(/^\s*(SIDECAR_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] in out) out[m[1]] = m[2];
  }
  return out;
}

// 更新 .env 中的键。只改写已存在的 `KEY=...` 行、保留其余内容与注释；
// 若该键尚未写入则追加到文件末尾。返回写入后的完整读取结果。
function write(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch 必须是对象');
  const current = read();
  const next = { ...current, ...patch };
  const lines = readRaw().split(/\r?\n/);
  const keys = Object.keys(patch);
  const present = new Set(keys.filter((k) => lines.some((l) => l.startsWith(`${k}=`))));
  const outLines = lines.map((l) => {
    for (const k of keys) {
      if (l.startsWith(`${k}=`)) return `${k}=${next[k]}`;
    }
    return l;
  });
  for (const k of keys) {
    if (!present.has(k)) outLines.push(`${k}=${next[k]}`);
  }
  fs.mkdirSync(path.dirname(DOTENV_PATH), { recursive: true });
  fs.writeFileSync(DOTENV_PATH, outLines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return read();
}

module.exports = { DEFAULTS, PANEL_KEYS, read, write };
