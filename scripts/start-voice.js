#!/usr/bin/env node
// Mirai 语音「一键启动」：探测 9880 -> 没跑就拉起 managed GPT-SoVITS 并等就绪 -> 再启动 Electron。
// 退出时，若 GPT-SoVITS 是本脚本拉起的，一并退出；复用已跑的服务则不碰。
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.MIRAI_SIDECAR_TTS_PORT || 9880);

// 定位 managed GPT-SoVITS：优先 vendor/gpt-sovits（可软链），其次 ~/GPT-SoVITS 兜底。
function locateGptSovits() {
  const candidates = [
    process.env.MIRAI_GPT_SOVITS_ROOT,
    path.join(APP_ROOT, 'vendor', 'gpt-sovits'),
    path.join(os.homedir(), 'GPT-SoVITS'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'api_v2.py'))) return fs.realpathSync(c);
  }
  return null;
}

function isListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

function ensureNltkTagger(root) {
  const python = path.join(root, '.venv', 'bin', 'python3');
  if (!fs.existsSync(python)) return false;
  const verify = "import nltk; nltk.data.find('taggers/averaged_perceptron_tagger_eng')";
  try {
    execFileSync(python, ['-c', verify], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    console.log('[start-voice] 补齐 GPT-SoVITS 所需的 NLTK 词性资源...');
    try {
      execFileSync(python, ['-c', "import nltk; raise SystemExit(0 if nltk.download('averaged_perceptron_tagger_eng') else 1)"], {
        cwd: root,
        env: { ...process.env, NLTK_ALLOW_PROXIED_URLOPEN: '1' },
        stdio: 'inherit',
      });
      execFileSync(python, ['-c', verify], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      console.error('[start-voice] NLTK 词性资源安装失败，语音启动已中止。');
      return false;
    }
  }
}
async function waitReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isListening(PORT)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function main() {
  const alreadyUp = await isListening(PORT);
  const root = locateGptSovits();
  if (root && !ensureNltkTagger(root)) process.exit(1);
  let ttsChild = null;
  if (!alreadyUp) {
    const venvPy = root ? path.join(root, '.venv', 'bin', 'python3') : null;
    const config = root ? path.join(root, 'GPT_SoVITS', 'configs', 'tts_infer_mac.yaml') : null;
    if (!root || !venvPy || !fs.existsSync(venvPy) || !fs.existsSync(config)) {
      console.error('[start-voice] 未找到可用的 GPT-SoVITS（需 api_v2.py + .venv + Mac CPU 配置）。');
      console.error('[start-voice] 请先运行：npm run setup:voice');
      process.exit(1);
    }
    console.log(`[start-voice] 启动 GPT-SoVITS（${root}）...`);
    ttsChild = spawn(venvPy, [path.join(root, 'api_v2.py'), '-a', '127.0.0.1', '-p', String(PORT), '-c', config], {
      cwd: root,
      stdio: 'inherit',
    });
    if (!(await waitReady())) {
      console.error('[start-voice] GPT-SoVITS 未能就绪，请查看上方日志。');
      ttsChild.kill('SIGTERM');
      process.exit(1);
    }
    console.log('[start-voice] GPT-SoVITS 就绪 ✓');
  } else {
    console.log(`[start-voice] 复用已在运行的 GPT-SoVITS（端口 ${PORT}）`);
  }

  const electronBin = path.join(APP_ROOT, 'node_modules', '.bin', 'electron');
  console.log('[start-voice] 启动小未来 ...');
  const electron = spawn(electronBin, ['.'], { cwd: APP_ROOT, stdio: 'inherit' });
  electron.on('exit', (code) => {
    if (ttsChild) {
      console.log('[start-voice] 关闭由本脚本拉起的 GPT-SoVITS ...');
      ttsChild.kill('SIGTERM');
    }
    process.exit(code ?? 0);
  });
}

main();
