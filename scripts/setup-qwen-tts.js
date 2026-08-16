// Qwen3TTS-Faster 后端「下载 + 解压 + 探测入口」助手。
//
// 背景：Mirai 语音侧车新引擎 qwen3（SIDECAR_TTS_ENGINE=qwen3）对接的是
// 开源后端 Qwen3TTS-Faster（ModelScope: HELPMEEADICE/Qwen3TTS-Faster）。
// 该后端以整包 7z 形式分发（含代码 + 权重），需先下载解压才能起服务。
// 本脚本负责前两步（下载 + 解压），并尽量探测服务启动入口；入口若探测不到，
// 会停在“请把解压目录结构/启动命令回传”这一步，由人工确认后补启动脚本。
//
// 端口约定：Qwen 后端默认 9980（与 gpt-sovits 的 9880 并存，双引擎切换）。
//
// 用法：
//   node scripts/setup-qwen-tts.js            # 下载 1.7b 标准版 + 解压 + 探测
//   env QWEN3_URL=<...> node scripts/setup-qwen-tts.js --dry-run   # 仅打印计划，不下载

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(APP_ROOT, 'vendor', 'qwen3tts');
const ARCHIVE = path.join(VENDOR, 'Qwen3TTS-1.7b-API.7z');

const MODELSCOPE_BASE = process.env.QWEN3_URL || 'https://modelscope.cn/models/HELPMEEADICE/Qwen3TTS-Faster/resolve/master';
// 标准版 1.7b（自配音色用 refer_wav，无需乐队 LoRA）。要换 0.6b 改这里文件名。
const ARCHIVE_NAME = 'Qwen3TTS-1.7b-API.7z';

const log = (...a) => console.log('[setup-qwen-tts]', ...a);
const err = (...a) => { console.error('[setup-qwen-tts] ✖', ...a); process.exit(1); };

function dryRun() { return process.argv.includes('--dry-run'); }

function unar() {
  for (const tool of ['unar', '7z', '7zz', '7za']) {
    const r = spawnSync('which', [tool], { encoding: 'utf8' });
    if (!r.status && r.stdout.trim()) return tool;
  }
  return null;
}

function download() {
  if (fs.existsSync(ARCHIVE)) { log(`已存在 ${ARCHIVE}，跳过下载`); return; }
  fs.mkdirSync(VENDOR, { recursive: true });
  if (dryRun()) { log(`[dry-run] curl -L -C - -o ${ARCHIVE} ${MODELSCOPE_BASE}/${ARCHIVE_NAME}`); return; }
  log(`下载 ${ARCHIVE_NAME}（约 5GB，ModelScope 直链，支持断点续传）...`);
  // -L 跟随重定向，-C - 断点续传，-# 进度条
  const r = spawnSync('curl', ['-L', '-C', '-', '-#', '-o', ARCHIVE, `${MODELSCOPE_BASE}/${ARCHIVE_NAME}`], { stdio: 'inherit' });
  if (r.status !== 0) err('下载失败（可重跑，配合 -C - 断点续传）。');
  log('下载完成。');
}

function extract() {
  const tool = unar();
  if (!tool) err('缺少 7z 解压工具：请先 `brew install unar`（或 p7zip）后重跑。');
  if (dryRun()) { log(`[dry-run] ${tool} 解压 ${ARCHIVE} → ${VENDOR}`); return; }
  let args;
  if (tool === 'unar') args = ['-f', '-o', VENDOR, ARCHIVE];
  else args = ['x', `-o${VENDOR}`, ARCHIVE];
  log(`用 ${tool} 解压（可能数分钟）...`);
  const r = spawnSync(tool, args, { stdio: 'inherit' });
  if (r.status !== 0) err('解压失败。');
  log('解压完成。');
}

// 探测解压后的服务启动入口：找含 lora/list 端点的 API server 脚本 / requirements / README。
function probe() {
  const hits = { server: [], req: [], readme: [] };
  if (!fs.existsSync(VENDOR)) return hits;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(py)$/i.test(e.name)) {
        let src = '';
        try { src = fs.readFileSync(p, 'utf8').slice(0, 200000); } catch { continue; }
        if (/lora\/list|lora\/unload|\/tts|uvicorn|FastAPI|Flask/.test(src)) hits.server.push(p);
      } else if (/^requirements.*\.txt$/i.test(e.name)) hits.req.push(p);
      else if (/readme\.md$/i.test(e.name)) hits.readme.push(p);
    }
  };
  walk(VENDOR, 0);
  return hits;
}

function main() {
  log('目标：Qwen3TTS-Faster 后端 → ' + VENDOR);
  download();
  extract();
  const h = probe();
  if (h.server.length) {
    log('可能的后端入口脚本：');
    h.server.forEach((p) => log('  · ' + p));
    log('requirements：' + (h.req.join('; ') || '(未找到)'));
    log('—— 请把上面亮出的入口脚本 README/requirements 内容回传，我再补 start-voice 的拉起逻辑。');
  } else if (h.req.length || h.readme.length) {
    log('未直接探测到 API 入口，但发现：');
    h.req.forEach((p) => log('  · requirements: ' + p));
    h.readme.forEach((p) => log('  · README: ' + p));
    log('请把解压目录结构截图/`find vendor/qwen3tts -maxdepth 2` 结果回传，确认启动方式。');
  } else {
    log('仍未探测到入口。请执行并回传：`find vendor/qwen3tts -maxdepth 2 -type f | head -50`');
  }
}

main();
