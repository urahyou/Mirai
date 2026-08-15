#!/usr/bin/env node
// Mirai 语音组件「一键安装」：把 GPT-SoVITS 纳入项目 vendor/ 目录，并写好 .env。
//
// 策略（由快→慢）：
//   1) vendor/gpt-sovits 已就绪 -> 直接复用
//   2) 检测到本机 ~/GPT-SoVITS 已装好 -> 软链挂进 vendor/（不重复下载/安装）
//   3) 都没有 -> clone RVC-Boss/GPT-SoVITS 到 vendor/，建 venv、装依赖、下权重
// 最后：确认 Mac CPU 配置存在、写入 .env 的 SIDECAR_TTS_*（引擎指向 gpt-sovits）。
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const VENDOR = path.join(APP_ROOT, 'vendor', 'gpt-sovits');
const LEGACY = path.join(process.env.HOME || '', 'GPT-SoVITS');
const REPO = 'https://github.com/RVC-Boss/GPT-SoVITS';
const CONFIG_REL = 'GPT_SoVITS/configs/tts_infer_mac.yaml';
const REQUIREMENTS = 'requirements.txt';

const log = (...a) => console.log(`[setup-voice]`, ...a);
const err = (m) => { console.error(`[setup-voice] ❌ ${m}`); process.exit(1); };

function isReady(dir) {
  return (
    dir &&
    fs.existsSync(path.join(dir, 'api_v2.py')) &&
    fs.existsSync(path.join(dir, '.venv', 'bin', 'python3')) &&
    fs.existsSync(path.join(dir, CONFIG_REL))
  );
}

function ensureMacConfig(root) {
  const target = path.join(root, CONFIG_REL);
  if (fs.existsSync(target)) return '已存在';
  const yaml = [
    '# Mirai Mac(CPU) 专用 TTS 配置 —— v2final 基座权重作零样本音色克隆',
    'custom:',
    '  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
    '  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base',
    '  device: cpu',
    '  is_half: false',
    '  t2s_weights_path: GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt',
    '  version: v2',
    '  vits_weights_path: GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, yaml);
  return '已生成';
}

function symlink(src) {
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  try { fs.symlinkSync(src, VENDOR, 'dir'); log(`软链 vendor/gpt-sovits -> ${src}`); }
  catch (e) {
    if (fs.existsSync(VENDOR)) log(`vendor/gpt-sovits 已存在，跳过软链`);
    else err(`软链失败: ${e.message}`);
  }
}

function freshClone() {
  log(`clone ${REPO} -> vendor/gpt-sovits ...`);
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  execSync(`git clone --depth 1 ${REPO} "${VENDOR}"`, { stdio: 'inherit', cwd: APP_ROOT });
  log('建 venv 并装依赖（含 torch，需几分钟）...');
  const basePy = process.env.MIRAI_WARASHI_ROOT
    ? path.join(process.env.MIRAI_WARASHI_ROOT, '.venv', 'bin', 'python3')
    : (() => { try { execSync('command -v python3', { stdio: 'ignore' }); return 'python3'; } catch { return 'python3'; } })();
  execSync(`uv venv --system-site-packages .venv --python "${basePy}"`, { stdio: 'inherit', cwd: VENDOR });
  execSync(`uv pip install --python .venv/bin/python -r ${REQUIREMENTS}`, { stdio: 'inherit', cwd: VENDOR });
  log('⚠️  请手动下载基座权重（gsv-v2final）放到 GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/：');
  log('    v2 三件套 s1bert25hz-5kh...(ckpt) / s2G2333k.pth / s2D2333k.pth + 两个 bert 预训练模型。');
}

function wireEnv(root) {
  const sidecarEnv = require(path.join(APP_ROOT, 'src', 'services', 'sidecar-env'));
  const current = sidecarEnv.read();
  const patch = {
    SIDECAR_TTS_ENGINE: 'gpt-sovits',
    SIDECAR_TTS_URL: 'http://127.0.0.1:9880/',
    // 若 .env 还没参考音频，填一个占位提示（用户可在语音设置里改）
    ...(!current.SIDECAR_TTS_REF_WAV ? { SIDECAR_TTS_REF_WAV: `${root}/audio_reference` } : {}),
  };
  sidecarEnv.write(patch);
  log('.env 已写入 SIDECAR_TTS_ENGINE=gpt-sovits、TTS_URL=http://127.0.0.1:9880/');
}

function main() {
  if (isReady(VENDOR)) {
    log('vendor/gpt-sovits 已就绪，复用。');
  } else if (fs.existsSync(path.join(VENDOR, 'api_v2.py'))) {
    log('vendor/gpt-sovits 已存在但缺 venv/配置，补全中...');
    if (!fs.existsSync(path.join(VENDOR, '.venv'))) freshClone();
    else ensureMacConfig(VENDOR);
    if (!isReady(VENDOR)) err('vendor 缺组件，请检查后重试。');
  } else if (isReady(LEGACY)) {
    log(`检测到本机已装好 GPT-SoVITS（${LEGACY}），软链挂进项目，不重复安装。`);
    symlink(LEGACY);
    if (!isReady(VENDOR)) err('软链后仍判定未就绪，请检查。');
  } else {
    freshClone();
  }
  const root = fs.realpathSync(VENDOR).replace(/\/+$/, '');
  ensureMacConfig(root);
  wireEnv(root);
  log('✅ 安装完成。启动：npm run start:voice');
}

main();
