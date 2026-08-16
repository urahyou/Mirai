#!/usr/bin/env node
// 小未来（Mirai）一键启动：Neo4j + Graphiti 记忆侧车 + Electron 桌宠本体。
// 语音侧车由 Electron 主进程（voice-bridge）自动拉起，无需在此额外处理。
// 用法：npm run start:all
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const children = [];

const log = (...a) => console.log('[start-all]', ...a);

// 从项目根 .env 读取配置（不打印密钥）
function dotenv(key, fallback = '') {
  try {
    const raw = fs.readFileSync(path.join(APP_ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].trim();
    }
  } catch { /* 无 .env */ }
  return fallback;
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
  const password = dotenv('GRAPHITI_NEO4J_PASSWORD', 'mirai-dev-password');
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

// 3) 启动 Electron 桌宠本体（语音侧车 8765 由本体自动拉起）
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
startElectron();
