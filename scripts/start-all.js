#!/usr/bin/env node
// 小未来（Mirai）一键启动：Neo4j + Graphiti 记忆侧车 + Electron 桌宠本体。
// 语音侧车由 Electron 主进程（voice-bridge）自动拉起，无需在此额外处理。
// 用法：npm run start:all
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const children = [];

const dotenv = require('../src/services/dotenv');

const log = (...a) => console.log('[start-all]', ...a);

// 从项目根 .env 读取配置（不打印密钥；解析统一走 services/dotenv.js）
function dotenvVal(key, fallback = '') {
  return dotenv.read(key, fallback);
}

// 0) 清理占用指定端口的进程（避免重复一键启动时端口冲突）
function reclaimPort(port) {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      log(`端口 ${port} 已被 PID ${pid} 占用，清理后重新拉起`);
      try { process.kill(Number(pid), 'SIGTERM'); } catch { /* 忽略 */ }
    }
    return pids.length > 0;
  } catch {
    return false; // 无占用
  }
}

// 1) 确保 Neo4j 容器运行
function ensureNeo4j() {
  const name = 'mirai-neo4j';
  const password = dotenvVal('GRAPHITI_NEO4J_PASSWORD', 'mirai-dev-password');
  try {
    const exists = execSync(
      `docker ps -a --filter name=${name} --format '{{.Names}}'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!exists) {
      log(`创建并启动 Neo4j 容器 ${name} ...`);
      execSync(
        `docker run -d --name ${name} -p 7474:7474 -p 7687:7687 ` +
        `-e NEO4J_AUTH=neo4j/${password} neo4j:latest`,
        { stdio: 'inherit' },
      );
    } else {
      log(`启动 Neo4j 容器 ${name} ...`);
      execSync(`docker start ${name}`, { stdio: 'inherit' });
    }
  } catch (error) {
    log('⚠️ Neo4j 启动失败（需要 Docker daemon 运行）：', error.message);
  }
}

function isListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}
async function waitReady(port, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isListening(port)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// 2) 启动 Graphiti 记忆侧车（8766）
function startGraphiti() {
  reclaimPort(8766); // 先清掉可能残留的旧 sidecar，避免 Address already in use
  const venvPy = path.join(APP_ROOT, 'graphiti-sidecar', '.venv', 'bin', 'python');
  const script = path.join(APP_ROOT, 'graphiti-sidecar', 'server.py');
  const child = spawn(venvPy, [script], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => { if (code) log(`Graphiti sidecar 退出 code=${code}`); });
  children.push(child);
  log('Graphiti 记忆侧车已启动 (8766)');
}

// 3) 若配置了 gpt-sovits 引擎，自动拉起 GPT-SoVITS 服务（9880）
function startTts() {
  const engine = dotenvVal('SIDECAR_TTS_ENGINE', 'edge').toLowerCase();
  const enabled = dotenvVal('SIDECAR_TTS_ENABLED', 'true').toLowerCase() !== 'false';
  if (engine !== 'gpt-sovits' || !enabled) {
    log(`TTS 引擎=${engine}，无需本地 GPT-SoVITS`);
    return;
  }
  const port = Number(dotenvVal('MIRAI_SIDECAR_TTS_PORT', '9880'));
  const candidates = [
    process.env.MIRAI_GPT_SOVITS_ROOT,
    path.join(APP_ROOT, 'vendor', 'gpt-sovits'),
    path.join(os.homedir(), 'GPT-SoVITS'),
  ].filter(Boolean);
  const root = candidates.find((c) => fs.existsSync(path.join(c, 'api_v2.py')));
  if (!root) {
    log('⚠️ 未找到 GPT-SoVITS（缺 api_v2.py），请先 npm run setup:voice');
    return;
  }
  const venvPy = path.join(root, '.venv', 'bin', 'python3');
  const config = path.join(root, 'GPT_SoVITS', 'configs', 'tts_infer_mac.yaml');
  if (!fs.existsSync(venvPy) || !fs.existsSync(config)) {
    log('⚠️ GPT-SoVITS venv 或 Mac 配置缺失，跳过');
    return;
  }
  if (isListening(port)) {
    log(`复用已在运行的 GPT-SoVITS（端口 ${port}）`);
    return;
  }
  log(`拉起 GPT-SoVITS（${root}）...`);
  const child = spawn(
    venvPy,
    [path.join(root, 'api_v2.py'), '-a', '127.0.0.1', '-p', String(port), '-c', config],
    { cwd: root, stdio: 'inherit' },
  );
  children.push(child);
  waitReady(port, 120000).then((ok) => {
    log(ok ? `GPT-SoVITS 就绪 ✓（端口 ${port}）` : '⚠️ GPT-SoVITS 120s 内未就绪');
  });
}

// 4) 启动 Electron 桌宠本体（语音侧车 8765 由本体自动拉起）
function startElectron() {
  const bin = path.join(APP_ROOT, 'node_modules', '.bin', 'electron');
  const child = spawn(bin, ['.'], { cwd: APP_ROOT, stdio: 'inherit' });
  child.on('exit', (code) => log(`小未来退出 code=${code ?? 0}`));
  children.push(child);
  log('小未来桌宠本体已启动');
}

function cleanup(code = 0) {
  log('正在停止子进程 ...');
  for (const child of children) {
    try { if (!child.killed) child.kill('SIGTERM'); } catch { /* 忽略 */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

ensureNeo4j();
startGraphiti();
startTts();
startElectron();
