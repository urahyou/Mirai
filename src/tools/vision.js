#!/usr/bin/env node
// 视觉描述工具：把本地图片委托给远端多模态模型(qwen3.6-35b-a3b) 分析。
// 配置(密钥/地址)从 ~/.pi/agent/models.json 的 lab provider 读取，不入仓库。
// 用法:
//   node src/tools/vision.js --image /tmp/shot.png [--question "这是什么?"] [--max-tokens 300]
//   --raw          只输出纯文本答案
//   --json         输出 {ok, answer, model}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadConfig() {
  const p = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const lab = raw.providers && raw.providers.lab;
  if (!lab) throw new Error('未在 ~/.pi/agent/models.json 找到 lab provider');
  return {
    baseUrl: lab.baseUrl,
    apiKey: lab.apiKey || '',
    model: 'qwen3.6-35b-a3b',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k, def) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : def; };
  const has = (k) => argv.includes('--' + k);
  const imagePath = get('image');
  const question = get('question') || '请详细描述这张截图的内容，包括界面上可见的文本、按钮、状态和布局。';
  const maxTokens = Number(get('max-tokens', 700));

  if (!imagePath) { console.error('用法: vision.js --image <path> [--question "..." ]'); process.exit(2); }
  if (!fs.existsSync(imagePath)) { console.error('图片不存在:', imagePath); process.exit(2); }
  const ext = path.extname(imagePath).toLowerCase().slice(1) || 'png';
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/png';
  const b64 = fs.readFileSync(imagePath).toString('base64');

  const cfg = loadConfig();
  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    max_tokens: maxTokens,
  };
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  let answer = (msg.content && String(msg.content).trim()) || '';
  // 推理型多模态模型可能把最终答案放 content=null、正文在 reasoning；取 reasoning 末尾作为降级
  if (!answer && msg.reasoning) {
    const r = String(msg.reasoning).trim();
    answer = r.split(/\n+/).filter((l) => l && !l.includes('```') && !/\d+\.\s*分析/.test(l)).slice(-6).join('\n');
  }
  const out = answer.trim() || '(模型未返回可读内容)';
  if (has('json')) console.log(JSON.stringify({ ok: true, answer: out, model: cfg.model }));
  else console.log(out);
}

main().catch((e) => { console.error('vision 失败:', e.message); process.exit(1); });
