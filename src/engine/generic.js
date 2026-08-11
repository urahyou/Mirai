const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./rules');

// 通用 OpenAI 兼容 LLM 调用器
// 从 src/core/llm-providers.json 读取 provider 配置，
// 通过标准的 /v1/chat/completions 接口与本地或局域网大模型通信。

const PROVIDERS_PATH = path.join(__dirname, '..', 'core', 'llm-providers.json');

let providerCache = null;
let activeProviderName = null;

// 多轮会话记忆：保留最近的对话轮次（user + assistant 配对）
const HISTORY_MAX_TURNS = 12; // 最多保留 12 对 (user/assistant)
let history = [];

// 完整对话请求超时（毫秒）。防止 LLM 连接后一直无响应导致输入窗口永久禁用。
const CHAT_REQUEST_TIMEOUT_MS = 60000;

function loadProviders() {
  if (providerCache) return providerCache;
  providerCache = JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
  const keys = Object.keys(providerCache.providers);
  activeProviderName = keys.length > 0 ? (providerCache.activeProvider || keys[0]) : '';
  return providerCache;
}

function getProviderConfig() {
  return JSON.parse(JSON.stringify(loadProviders()));
}

function normalizeProviderConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.providers || typeof raw.providers !== 'object') {
    throw new TypeError('Provider 配置格式不正确');
  }
  const providers = {};
  for (const [name, provider] of Object.entries(raw.providers)) {
    const key = String(name).trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key) || !provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new TypeError('Provider 名称或配置不正确');
    }
    const baseUrl = String(provider.baseUrl || '').trim().replace(/\/$/, '');
    const defaultModel = String(provider.defaultModel || '').trim();
    if (!/^https?:\/\//.test(baseUrl) || !defaultModel) throw new TypeError(`${key} 缺少有效的地址或模型名`);
    const temperature = Number(provider.temperature);
    const topP = Number(provider.topP);
    providers[key] = {
      label: String(provider.label || key).trim().slice(0, 80) || key,
      type: 'openai-compatible',
      baseUrl,
      apiKey: String(provider.apiKey || 'none').trim() || 'none',
      defaultModel,
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 0.8,
      topP: Number.isFinite(topP) ? Math.max(0, Math.min(1, topP)) : 0.9,
    };
  }
  const names = Object.keys(providers);
  if (!names.length) throw new TypeError('至少保留一个 Provider');
  return { activeProvider: names.includes(raw.activeProvider) ? raw.activeProvider : names[0], providers };
}

function saveProviderConfig(raw) {
  const config = normalizeProviderConfig(raw);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(config, null, 2));
  providerCache = null;
  activeProviderName = null;
  return getProviderConfig();
}

/**
 * 按配置中的顺序返回 provider 名称链（即优先级从高到低）。
 * 顺序 = llm-providers.json 中 providers 对象的键顺序（写入时保留数组/对象顺序）。
 */
function providerChain() {
  loadProviders();
  const keys = Object.keys(providerCache.providers);
  // active 排最前，其余保持配置顺序
  const act = providerCache.activeProvider || activeProviderName || '';
  if (act && keys.includes(act)) {
    return [act, ...keys.filter((k) => k !== act)];
  }
  return keys;
}

/**
 * 检查某个 provider 是否可用
 */
async function isAvailable(name) {
  loadProviders();
  if (!name) name = activeProviderName;
  const provider = providerCache.providers[name];
  if (!provider) return false;
  try {
    console.log(`[LLM] checking ${name}: ${provider.baseUrl}/models`);
    const res = await fetch(provider.baseUrl.replace(/\/$/, '') + '/models', {
      signal: AbortSignal.timeout(2000),
      headers: providerKey(provider) ? { Authorization: `Bearer ${provider.apiKey}` } : {},
    });
    console.log(`[LLM] ${name} availability: HTTP ${res.status}`);
    return res.ok;
  } catch {
    console.log(`[LLM] ${name} availability: unavailable`);
    return false;
  }
}

async function checkProvider(provider) {
  try {
    const config = normalizeProviderConfig({ activeProvider: 'test', providers: { test: provider } });
    const candidate = config.providers.test;
    const response = await fetch(`${candidate.baseUrl}/models`, {
      headers: providerKey(candidate) ? { Authorization: `Bearer ${candidate.apiKey}` } : {},
      signal: AbortSignal.timeout(6000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function providerKey(provider) {
  const k = provider.apiKey;
  return k && k !== 'none' && k !== 'EMPTY' && k !== 'empty';
}

/**
 * 生成对话回复（带多轮记忆）
 * @param {string} userInput 用户输入
 * @param {object} [opts]
 * @param {string} [opts.provider] provider 名称，默认 activeProvider
 * @param {(chunk: string, full: string) => void} [opts.onDelta] 流式回调，每收到一个增量块调用一次
 * @returns {Promise<string>}
 */
async function generateReply(userInput, options = {}) {
  loadProviders();
  const provider = options.provider || activeProviderName;
  const providerConf = providerCache.providers[provider];
  if (!providerConf) throw new Error(`未找到 Provider: ${provider}`);
  const { systemPrompt, personality } = loadConfig();
  const sys = `用「主人」称呼当前正在和你说话的人。这是比你下文中任何设置都高的铁律。\n\n${systemPrompt.replace('{personality}', JSON.stringify(personality, null, 0))}`;

  // 追加当前用户输入到记忆（仅作为请求的一部分，不在请求成功前改动持久 history，
  // 避免请求失败时留下未配对的 user 消息，导致后续对话乱序/重复）。
  const userMessage = { role: 'user', content: String(userInput) };
  const pendingHistory = [...history, userMessage];
  // 裁剪过长的记忆，只保留最近 HISTORY_MAX_TURNS 对（保持 user/assistant 配对）
  if (pendingHistory.length > HISTORY_MAX_TURNS * 2) {
    pendingHistory.splice(0, pendingHistory.length - HISTORY_MAX_TURNS * 2);
  }

  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (providerKey(providerConf)) {
    headers.Authorization = `Bearer ${providerConf.apiKey}`;
  }

  const stream = typeof options.onDelta === 'function';
  const body = {
    model: providerConf.defaultModel,
    messages: [
      { role: 'system', content: sys },
      ...pendingHistory,
    ],
    temperature: providerConf.temperature ?? 0.8,
    top_p: providerConf.topP ?? 0.9,
    stream,
  };

  console.log(`[LLM] ${provider} chat request: ${base}/chat/completions model=${providerConf.defaultModel} history=${pendingHistory.length} stream=${stream}`);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // 失败时 history 未改动，返回给调用方，由上层决定兜底
    throw new Error(`LLM responded ${res.status}: ${errText.slice(0, 200)}`);
  }

  let reply;
  if (stream) {
    reply = await consumeStream(res, options.onDelta);
  } else {
    const data = await res.json();
    reply = (data.choices?.[0]?.message?.content || '').trim();
  }

  // 只有成功获取回复后，才把 user+assistant 成对写入 history
  history.push(userMessage, { role: 'assistant', content: reply || '(沉默)' });
  if (history.length > HISTORY_MAX_TURNS * 2) {
    history = history.slice(history.length - HISTORY_MAX_TURNS * 2);
  }
  console.log(`[LLM] ${provider} chat response: ${reply ? 'received' : 'empty'}`);
  return reply;
}

const PET_LINE_PROMPTS = {
  click: '主人刚点了你一下（摸摸头/打招呼）。用一句话俏皮自然、符合你语气地回应，顺带关心一下主人。只输出这一句话，不要加引号或前缀。',
};

// 生成一句不带上下文的点击回应，不进入多轮历史
async function generatePetLine({ provider, purpose = 'click' } = {}) {
  loadProviders();
  const name = provider || activeProviderName;
  const providerConf = providerCache.providers[name];
  if (!providerConf) throw new Error(`未找到 Provider: ${name}`);
  const { systemPrompt, personality } = loadConfig();
  let sys = `用「主人」称呼对方。这是比你下文中任何设置都高的铁律。\n\n${systemPrompt.replace('{personality}', JSON.stringify(personality, null, 0))}`;
  const instruction = PET_LINE_PROMPTS[purpose] || PET_LINE_PROMPTS.click;
  sys += `\n\n${instruction}`;

  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (providerKey(providerConf)) {
    headers.Authorization = `Bearer ${providerConf.apiKey}`;
  }
  const body = {
    model: providerConf.defaultModel,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: '（该你开口了）' },
    ],
    temperature: providerConf.temperature ?? 0.8,
    top_p: providerConf.topP ?? 0.9,
    stream: false,
  };

  console.log(`[LLM] ${name} pet-line request purpose=${purpose} model=${providerConf.defaultModel}`);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM responded ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const reply = (data.choices?.[0]?.message?.content || '').trim();
  console.log(`[LLM] ${name} pet-line response purpose=${purpose}: ${reply ? 'received' : 'empty'}`);
  return reply;
}

/**
 * 读取 SSE 流，逐个 delta 回调，返回完整文本
 */
async function consumeStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let done = false;

  const consumeLine = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta, full);
      }
    } catch {
      // 忽略无法解析的行
    }
  };

  while (!done) {
    const { value, done: finished } = await reader.read();
    done = finished;
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const raw of lines) consumeLine(raw);
      }
  }
  if (buffer) consumeLine(buffer);
  return full.trim();
}

module.exports = {
  loadProviders,
  getProviderConfig,
  saveProviderConfig,
  providerChain,
  isAvailable,
  checkProvider,
  generateReply,
  generatePetLine,
};
