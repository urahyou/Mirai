// 语音侧车环境变量服务：读写项目根 .env 里的 SIDECAR_* 键。
// 统一由 services/dotenv.js 承担 .env 的解析与写入，本模块只管面板可控键的取值/默认值。
const dotenv = require('./dotenv');

// 面板可控键的默认值（.env 里没写时用这里）
const DEFAULTS = Object.freeze({
  SIDECAR_TTS_ENGINE: 'edge',
  SIDECAR_TTS_ENABLED: 'true',
  SIDECAR_TTS_URL: 'http://127.0.0.1:9880/',
  SIDECAR_TTS_REF_WAV: '',
  SIDECAR_TTS_PROMPT_TEXT: '',
  SIDECAR_TTS_PROMPT_LANG: 'zh',
  SIDECAR_TTS_TEXT_LANGUAGE: 'zh',
  SIDECAR_TTS_SPEAK_LANG: '',
  SIDECAR_TTS_TEMPERATURE: '0.9',
  SIDECAR_TTS_SPEED_FACTOR: '1.0',
});
const PANEL_KEYS = ['SIDECAR_TTS_ENGINE', 'SIDECAR_TTS_TEXT_LANGUAGE', 'SIDECAR_TTS_SPEAK_LANG', 'SIDECAR_TTS_ENABLED'];

// 读取 .env 里的 SIDECAR_* 值（与默认值合并）
function read() {
  const out = { ...DEFAULTS };
  const all = dotenv.readAll();
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(all, k)) out[k] = all[k];
  }
  return out;
}

// 更新 .env 中的键。只改写已存在的 `KEY=...` 行、保留其余内容与注释；
// 若该键尚未写入则追加到文件末尾（统一由 services/dotenv.js 实现）。返回写入后的完整读取结果。
function write(patch) {
  dotenv.write(patch);
  return read();
}

module.exports = { DEFAULTS, PANEL_KEYS, read, write };
