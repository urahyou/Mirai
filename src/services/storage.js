// 统一持久化抽象（JSON 起底，带 schema 版本 + 迁移钩子）。
//
// 设计（对照 AGENTS 决策 D2）：
// - 多 key，每个 key 一个独立文件：<runtimeDir>/<key>.json
// - 每个 key 通过 register() 声明 { version, defaults, migrations, normalize, fileName }
// - 读取时：原始 JSON → 按版本逐级迁移(迁移钩子) → 补默认值 → normalize 校验，任何一步失败安全回退默认值
// - 写入时：与当前读到的内容合并 → 补 version → normalize → 原子写（临时文件 + rename，防写一半损坏）
//
// 拒绝散装 JSON：所有状态/领域系统统一走这里，格式由 schema 单点约束，为将来迁 SQLite 留好接口。
//
// 用法：
//   const storage = require('./storage');
//   storage.setRuntimeDir(app.getPath('userData'));
//   storage.register('emotion', { version: 1, defaults: { moodScore: 50 }, migrations: {}, normalize: normalizeEmotion });
//   const s = storage.read('emotion');
//   storage.write('emotion', { moodScore: 60 });

const fs = require('fs');
const path = require('path');

let runtimeDir = null;
// key -> { version, defaults, migrations, normalize, fileName }
const schemas = new Map();

function setRuntimeDir(dir) {
  runtimeDir = dir || null;
}

// opts: { version:Number(默认1), defaults:Object, migrations:Object(旧版本号->迁移函数), normalize:Function, fileName:String }
function register(key, opts = {}) {
  if (!key) throw new TypeError('storage key 必填');
  const version = opts.version === undefined ? 1 : opts.version;
  const defaults = opts.defaults && typeof opts.defaults === 'object' ? opts.defaults : {};
  const migrations = opts.migrations || {};
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`storage "${key}" version 必须是 >=1 的整数`);
  for (const v of Object.keys(migrations)) {
    if (typeof migrations[v] !== 'function') throw new TypeError(`storage "${key}" migrations[${v}] 必须是函数`);
  }
  schemas.set(key, {
    version,
    defaults,
    migrations,
    normalize: opts.normalize || null,
    fileName: opts.fileName || `${key}.json`,
  });
}

function has(key) {
  return schemas.has(key);
}

function readRaw(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 按版本逐级迁移：doc.version 从旧值逐级升到当前 version，每步调对应迁移钩子。
function migrate(key, doc) {
  const { version, migrations } = schemas.get(key);
  let cur = doc;
  let curVer = doc && Number.isFinite(doc.version) ? Math.round(doc.version) : 0;
  if (curVer > version) {
    // 未知的未来版本：不强行降级，按当前版本可用数据回退
    return { doc: null, curVer };
  }
  while (curVer < version) {
    const step = curVer + 1;
    const fn = migrations[step];
    if (typeof fn !== 'function') break; // 缺迁移钩子则停，保留当前结构
    const next = fn(cur);
    if (!next || typeof next !== 'object') return { doc: null, curVer: step }; // 迁移产出非法则回退
    cur = next;
    curVer = step;
  }
  return { doc: cur, curVer };
}

function applyDefaults(key, doc) {
  const { defaults } = schemas.get(key);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ...defaults };
  return { ...defaults, ...doc };
}

function applyNormalize(key, doc) {
  const { normalize } = schemas.get(key);
  return typeof normalize === 'function' ? normalize(doc) : doc;
}

// version 是内部迁移元数据，不进公开文档（读写一致地剥离）
function stripVersion(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const { version, ...rest } = doc;
  return rest;
}

function read(key) {
  if (!schemas.has(key)) throw new Error(`storage key "${key}" 未注册`);
  const { fileName } = schemas.get(key);
  const base = runtimeDir ? readRaw(path.join(runtimeDir, fileName)) : null;
  const { doc } = migrate(key, base);
  // 迁移失败或读到未来版本 → 回退默认值；对象必须版本化
  const merged = applyDefaults(key, doc);
  const normalized = applyNormalize(key, merged);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return applyDefaults(key, doc);
  return stripVersion(normalized);
}

function write(key, data) {
  if (!runtimeDir) throw new Error('storage runtime dir 未初始化');
  if (!schemas.has(key)) throw new Error(`storage key "${key}" 未注册`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('storage data 必须是对象');
  const { version, fileName } = schemas.get(key);
  const current = read(key);
  const merged = { ...current, ...data };
  const normalized = applyNormalize(key, merged);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new TypeError(`storage "${key}" normalize 后必须是对象`);
  }
  atomicWrite(path.join(runtimeDir, fileName), JSON.stringify({ version, ...normalized }, null, 2));
  return stripVersion(normalized);
}

// 原子写：写临时文件后 rename，避免写一半崩溃残留损坏文件。
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 仅供测试：返回已注册 key 集合
function _keys() {
  return [...schemas.keys()];
}

// 仅供测试：清空已注册 schema（避免测试进程内 key 累积）
function _reset() {
  schemas.clear();
}

module.exports = { setRuntimeDir, register, read, write, has, _keys, _reset };
