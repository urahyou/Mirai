const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./rules');

// 通用 OpenAI 兼容 LLM 调用器
// 从 src/core/llm-providers.json 读取 provider 配置，
// 通过标准的 /v1/chat/completions 接口与本地部署的大模型通信（DeepSeek / Ollama / LM Studio / vLLM 等）

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

function getActiveProvider() {
  loadProviders();
  if (!activeProviderName || !providerCache.providers[activeProviderName]) {
    const keys = Object.keys(providerCache.providers);
    activeProviderName = keys.length > 0 ? keys[0] : '';
  }
  if (!activeProviderName) throw new Error('没有配置可用的 LLM Provider');
  const conf = providerCache.providers[activeProviderName];
  if (!conf) throw new Error('没有配置可用的 LLM Provider');
  return { name: activeProviderName, ...conf };
}

function getActiveProviderName() {
  loadProviders();
  if (!activeProviderName) return '';
  return activeProviderName;
}

function setActiveProvider(name) {
  loadProviders();
  if (providerCache.providers[name]) {
    activeProviderName = name;
    providerCache.activeProvider = name;
    saveProviders(providerCache);
    return true;
  }
  return false;
}

function listProviders() {
  loadProviders();
  return Object.entries(providerCache.providers).map(([name, p]) => ({
    name,
    label: p.label,
    model: p.defaultModel,
  }));
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

function providerKey(provider) {
  const k = provider.apiKey;
  return k && k !== 'none' && k !== 'EMPTY' && k !== 'empty';
}

// 把外部生成、预算受限的记忆上下文标记为「可能相关的历史信息」加入系统 prompt。
// 把外部生成的记忆按「方案 C 分层」注入 system prompt。
// memory 可以是 { core, working }（新），或旧的 memoryContext 字符串（兼容）。
// core=常驻画像，working=本次动态检索；两段都以「仅供参考、别编造」为注脚。
function buildBasePrompt({ system, emotionState, memory, memoryContext }) {
  const parts = [system];
  if (emotionState) {
    parts.push(`\n\n当前情感状态（仅用于调整语气，不要直接向用户暴露数值）：${JSON.stringify({
      mood: emotionState.mood,
      affection: emotionState.affection,
      energy: emotionState.energy,
      health: emotionState.health,
      stress: emotionState.stress,
      loneliness: emotionState.loneliness,
    })}`);
  }
  const isObject = memory && typeof memory === 'object' && !Array.isArray(memory);
  const core = isObject ? memory.core : (typeof memory === 'string' ? memory : undefined);
  const working = isObject ? memory.working : '';
  const legacy = memoryContext && typeof memoryContext === 'string' ? memoryContext : '';
  const pushLayer = (label, text) => {
    if (typeof text === 'string' && text.trim()) {
      parts.push(`\n\n${label}（可能相关的历史信息，仅供参考；若无法确认是事实，就当没这回事，别编造）：\n${text.trim()}`);
    }
  };
  pushLayer('以下是你一直记得的核心信息', core);
  pushLayer('以下可能是与本次对话相关的历史信息', working || legacy);
  return parts.join('');
}

/**
 * 生成对话回复（带多轮记忆）
 * @param {string} userInput 用户输入
 * @param {object} [opts]
 * @param {string} [opts.provider] provider 名称，默认 activeProvider
 * @param {object} [opts.emotionState] 情感状态对象
 * @param {(chunk: string, full: string) => void} [opts.onDelta] 流式回调，每收到一个增量块调用一次
 * @returns {Promise<string>}
 */
async function generateReply(userInput, options = {}) {
  loadProviders();
  const provider = options.provider || activeProviderName;
  const providerConf = providerCache.providers[provider];
  if (!providerConf) throw new Error(`未找到 Provider: ${provider}`);
  const { systemPrompt, personality } = loadConfig();
  let baseSystemPrompt = systemPrompt.replace('{personality}', JSON.stringify(personality, null, 0));
  const ownerName = typeof options.ownerName === 'string' ? options.ownerName.trim() : '';
  const callName = ownerName || '主人';
  baseSystemPrompt = `用「${callName}」称呼当前正在和你说这话的人。这是比你下文中任何设置都高的铁律。\n\n${baseSystemPrompt}`;
  const sys = buildBasePrompt({
    system: baseSystemPrompt,
    emotionState: options.emotionState,
    memory: options.memory || options.memoryContext,
  });

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
  idle: '现在你想主动和主人搭一句话：挑一个轻松随意的日常话题，用一句话主动开口（可以是关心、闲聊或找话题）。只输出这一句话，不要加引号或前缀。',
  click: '主人刚点了你一下（摸摸头/打招呼）。用一句话俏皮自然、符合你语气地回应，顺带关心一下主人。只输出这一句话，不要加引号或前缀。',
  greeting: '和主人打招呼：用一句话自然地问候。如果还不知道对方怎么称呼（此刻你就是第一次开机见到这位主人，对方的称呼未知），就顺势介绍自己并问问对方叫什么。只输出这一句话，不要加引号或前缀。',
};

// 生成一句不带上下文的角色台词（空闲搭话/点击回应/开场问候），不进入多轮历史
async function generatePetLine({ provider, purpose = 'idle', emotionState, ownerName } = {}) {
  loadProviders();
  const name = provider || activeProviderName;
  const providerConf = providerCache.providers[name];
  if (!providerConf) throw new Error(`未找到 Provider: ${name}`);
  const { systemPrompt, personality } = loadConfig();
  const knownOwnerName = typeof ownerName === 'string' ? ownerName.trim() : '';
  const callName = knownOwnerName || '主人';
  let sys = `用「${callName}」称呼对方。这是比你下文中任何设置都高的铁律。\n\n${systemPrompt.replace('{personality}', JSON.stringify(personality, null, 0))}`;
  const instruction = PET_LINE_PROMPTS[purpose] || PET_LINE_PROMPTS.idle;
  sys += `\n\n${instruction}`;
  const sysFull = buildBasePrompt({ system: sys, emotionState });

  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (providerKey(providerConf)) {
    headers.Authorization = `Bearer ${providerConf.apiKey}`;
  }
  const body = {
    model: providerConf.defaultModel,
    messages: [
      { role: 'system', content: sysFull },
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
 * 通用无历史单次生成（结构化内部任务用：记忆 Judge / 反思压缩等）。
 * - 不进入多轮 history，不污染会话记忆
 * - 省略 provider 时按 providerChain 自动回退可用项；传入 provider 则只用它
 * @returns {Promise<string>} 模型原文
 */
async function completion({ system, user, provider, temperature } = {}) {
  loadProviders();
  const names = provider
    ? [provider]
    : (providerChain().length ? providerChain() : [activeProviderName]);
  let lastErr = null;
  for (const name of names) {
    const providerConf = providerCache.providers[name];
    if (!providerConf) continue;
    if (!provider) {
      try {
        if (!(await isAvailable(name))) continue;
      } catch { continue; }
    }
    try {
      const base = providerConf.baseUrl.replace(/\/$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (providerKey(providerConf)) {
        headers.Authorization = `Bearer ${providerConf.apiKey}`;
      }
      const body = {
        model: providerConf.defaultModel,
        messages: [
          { role: 'system', content: String(system) },
          { role: 'user', content: String(user) },
        ],
        temperature: typeof temperature === 'number' ? temperature : (providerConf.temperature ?? 0.8),
        top_p: providerConf.topP ?? 0.9,
        stream: false,
      };
      console.log(`[LLM] ${name} completion request model=${providerConf.defaultModel}`);
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
      console.log(`[LLM] ${name} completion response: ${reply ? 'received' : 'empty'}`);
      return reply;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no usable provider');
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

/**
 * 清空会话记忆
 */
function clearHistory() {
  history = [];
}

/**
 * 保存 providers 配置到 JSON 文件（供面板调用）
 */
function saveProviders(raw) {
  const valid = raw && typeof raw === 'object';
  // 面板异常（如 _config 为 null/undefined）传入空 payload 时，保留现有配置，避免把 providers 清空导致菜单失效
  if (!valid || !raw.providers || typeof raw.providers !== 'object' || Object.keys(raw.providers).length === 0) {
    loadProviders(); // 确保 providerCache/activeProviderName 已加载
    const backup = providerCache ? providerCache.providers : {};
    const base = valid ? raw : {};
    const data = { ...base, providers: { ...backup } };
    fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(data, null, 2));
    providerCache = null;
    loadProviders();
    return;
  }
  const data = { ...(raw) };
  const keys = Object.keys(data.providers);
  // 优先采用面板标记的活跃 provider（_active），否则用模块级当前活跃，否则第一个
  const chosenActive = data._active || data.activeProvider || activeProviderName || keys[0];
  if (keys.length) {
    data.activeProvider = keys.includes(chosenActive) ? chosenActive : keys[0];
  } else {
    delete data.activeProvider;
  }
  delete data._active;
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(data, null, 2));
  providerCache = null; // 下次读取时刷新
  loadProviders();
}

/**
 * 给面板提供 checkProvider API，传入一个 provider 对象返回可用性
 */
async function checkProviderConf(provider) {
  try {
    const url = provider.baseUrl.replace(/\/$/, '') + '/models';
    const headers = providerKey(provider) ? { Authorization: `Bearer ${provider.apiKey}` } : {};
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = {
  loadProviders,
  getActiveProvider,
  getActiveProviderName,
  setActiveProvider,
  listProviders,
  providerChain,
  isAvailable,
  generateReply,
  generatePetLine,
  completion,
  buildBasePrompt,
  clearHistory,
  saveProviders,
  checkProviderConf,
};
