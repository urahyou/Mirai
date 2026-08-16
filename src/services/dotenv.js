// L2：项目根 .env 的统一读写服务（单一事实源）。
//
// 此前 .env 解析散落在 generic.js / voice-env.js / scripts/start-all.js 等多处，
// 语义各异（引号、export 前缀、注释处理不一致）。这里统一为一个解析+读写实现，
// 各处复用，消除重复与行为漂移。
//
// 安全约定：.env 里是敏感配置（API Key 等），本服务只在本机读写，不回传任何上游。
// 写入采用“仅改写已存在的 KEY= 行、未写则追加、保留注释与其它行”的策略。
const fs = require('fs');
const path = require('path');

const DEFAULT_DOTENV_PATH = path.join(__dirname, '..', '..', '.env');

let _path = DEFAULT_DOTENV_PATH;

function getPath() {
  return _path;
}

// 允许注入自定义路径（测试用，或需要指向其它 .env 时）。
function setPath(p) {
  _path = p || DEFAULT_DOTENV_PATH;
}

// 把 .env 文本解析为 {KEY: value}。
// 支持：# 注释行、可选 `export ` 前缀、单/双引号去包裹、剔除空白。
function parse(raw) {
  const values = {};
  if (!raw) return values;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

// 读取整个 .env，返回 {KEY: value}（文件缺失/不可读时返回空对象）。
function readAll() {
  try {
    return parse(fs.readFileSync(_path, 'utf8'));
  } catch {
    return {};
  }
}

// 读取单个键；未定义时返回 fallback。
function read(key, fallback = '') {
  const all = readAll();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
}

// 更新/追加 .env 中的键。
// - 只改写已存在的 `KEY=...` 行（保留注释与其它的行与顺序）；
// - 该键原本不存在则追加到文件末尾；
// - 键名须为纯大写字母/数字/下划线，值不得含换行（防止注入多行配置）；
// 返回写入后的完整读取结果。
function write(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch 必须是对象');
  let raw = '';
  try {
    raw = fs.readFileSync(_path, 'utf8');
  } catch {
    /* 首次写入：从空文件开始 */
  }
  const lines = raw.split(/\r?\n/);
  for (const [key, value] of Object.entries(patch)) {
    if (!/^[A-Z0-9_]+$/.test(key) || String(value).includes('\n')) continue;
    const line = `${key}=${String(value)}`;
    const index = lines.findIndex((entry) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(entry));
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  fs.mkdirSync(path.dirname(_path), { recursive: true });
  fs.writeFileSync(_path, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return readAll();
}

module.exports = { getPath, setPath, parse, readAll, read, write };
