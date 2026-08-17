const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./personality-config');
const prompts = require('./prompts');
const dotenv = require('../services/dotenv');

// 通用 OpenAI 兼容 LLM 调用器
// 从 src/templates/llm-providers.json 读取 provider 配置，
// 通过标准的 /v1/chat/completions 接口与本地或局域网大模型通信。

const DEFAULT_PROVIDERS_PATH = path.join(__dirname, '..', 'templates', 'llm-providers.json');

let providerCache = null;
let activeProviderName = null;
let runtimePath = null;

function loadDotEnv() {
  return dotenv.readAll();
}

function defaultApiKeyEnv(name) {
  return `MIRAI_PROVIDER_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function writeDotEnvValues(values) {
  dotenv.write(values);
}

// 多轮会话记忆：按 token 预算保留最近的对话（user + assistant 配对）。
// 主要限制从“轮数”改为“token 预算”（contextMaxTokens，由上下文设置面板滑条控制）。
const HISTORY_MAX_TURNS = 256; // 兜底最大轮数，防止 token 估算误差导致历史无限增长
const DEFAULT_CONTEXT_MAX_TOKENS = 4096; // 默认上下文 token 预算（与 context-budget 一致）
// ---- 上下文紧凑摘要压缩（AGENTS 工作偏好：约 80% 时自动压缩，勿等到接近上限） ----
const COMPRESSION_RATIO = 0.8; // 触发阈值：对话历史估算 token 占用预算达 80%
let history = [];

// 摘要缓存：当被压缩的早期对话内容不变时复用上次摘要，避免每个请求都多调一次 LLM
let summaryCache = { key: null, value: null };

const COMPRESSION_SYSTEM = '你是一个对话记忆压缩器。请把下面这段「小未来」（桌宠/伴侣）与主人的历史对话，压缩成一段紧凑的中文摘要，保留对后续回答有用的关键信息：人物的身份与关系、主人的重要个人情况、发生过的重要事件、主人的偏好与情绪、已经给过的承诺或约定。用简练的叙述句，不要罗列逐条对话，控制在 150 字以内。只输出摘要正文，不要任何额外前缀或解释。';

/**
 * 粗略估算一段文本的 token 数。无 tiktoken 依赖，用字符数近似：
 * 中文约 1 token/1.5 字，英文约 1 token/4 字符。这里保守取 1 token ≈ 1.4 字符，
 * 对中文和混合文本都偏安全（略高估，避免超限）。
 */
function estimateTokens(text) {
  const s = String(text || '');
  return Math.ceil(s.length * 0.7);
}

/**
 * 生成发送给模型的 messages 数组（不含 system），按 token 预算从后往前截断，
 * 保证保留最近的对话。
 * @param {Array<{role:string, content:string}>} msgs
 * @param {number} budget token 预算
 * @returns {{messages:Array, droppedTurns:number}}
 */
function truncateHistory(msgs, budget) {
  const list = Array.isArray(msgs) ? msgs.slice() : [];
  if (!Number.isFinite(budget) || budget <= 0) budget = DEFAULT_CONTEXT_MAX_TOKENS;
  if (!list.length) return { messages: [], droppedTurns: 0 };

  // 从后往前组包，直到累积 token 超预算或达到轮数兜底
  const selected = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    const dropMe = estimateTokens(msg.content);
    // 单条消息若超过整个预算，也必须保留（否则完全没上下文）
    if (selected.length > 0 && used + dropMe > budget) break;
    selected.unshift(msg);
    used += dropMe;
    // 轮数兜底：最多保留 HISTORY_MAX_TURNS 对，避免无限
    if (selected.length >= HISTORY_MAX_TURNS * 2) break;
  }
  return { messages: selected, droppedTurns: (list.length - selected.length) / 2 | 0 };
}

/**
 * 估算整段消息历史占用的 token 数（保守近似）。
 */
async function buildCompressedHistory(pendingHistory, totalBudget, providerConf) {
  // 保留最近 recentBudget token 的对话（完整保真），更早的全部压成一条摘要
  const recentBudget = Math.max(2000, Math.round(totalBudget * 0.35));
  const kept = [];
  let used = 0;
  for (let i = pendingHistory.length - 1; i >= 0; i--) {
    const m = pendingHistory[i];
    const t = estimateTokens(String(m.content || ''));
    if (kept.length > 0 && used + t > recentBudget) break;
    kept.unshift(m);
    used += t;
  }
  const oldCount = pendingHistory.length - kept.length;
  const old = pendingHistory.slice(0, oldCount);
  if (old.length < 2) {
    // 早期对话太少，没有可摘要的内容，回退为硬截断
    return { messages: truncateHistory(pendingHistory, totalBudget).messages, summarizedTurns: 0 };
  }
  const summary = await summarizeOldMessages(providerConf, old);
  return {
    messages: [{ role: 'system', content: `[对话前期摘要] ${summary}` }, ...kept],
    summarizedTurns: Math.round(old.length / 2),
  };
}

/**
 * 调用当前 provider 把某段早期对话压成紧凑摘要。相同内容命中缓存则跳过 LLM 调用。
 */
async function summarizeOldMessages(providerConf, old) {
  const key = JSON.stringify(old.map((m) => [m.role, m.content]));
  if (summaryCache.key === key) return summaryCache.value;
  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, authorizationHeaders(providerConf));
  const text = old
    .map((m) => `${m.role === 'user' ? '主人' : '小未来'}：${String(m.content || '')}`)
    .join('\n');
  const body = {
    model: providerConf.defaultModel,
    messages: [
      { role: 'system', content: COMPRESSION_SYSTEM },
      { role: 'user', content: text.slice(0, 20000) },
    ],
    temperature: 0.3,
    top_p: 0.9,
    stream: false,
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`summary LLM responded ${res.status}`);
  const data = await res.json();
  const summary = (data.choices?.[0]?.message?.content || '').trim();
  if (!summary) throw new Error('empty compression summary');
  summaryCache = { key, value: summary };
  return summary;
}

function resetConversationHistory() {
  history = [];
}

// 完整对话请求超时（毫秒）。防止 LLM 连接后一直无响应导致输入窗口永久禁用。
const CHAT_REQUEST_TIMEOUT_MS = 60000;

function loadProviders() {
  if (providerCache) return providerCache;
  const source = runtimePath && fs.existsSync(runtimePath) ? runtimePath : DEFAULT_PROVIDERS_PATH;
  providerCache = normalizeProviderConfig(JSON.parse(fs.readFileSync(source, 'utf8')));
  const keys = Object.keys(providerCache.providers);
  activeProviderName = keys.length > 0 ? (providerCache.activeProvider || keys[0]) : '';
  return providerCache;
}

function getProviderConfig() {
  const config = JSON.parse(JSON.stringify(loadProviders()));
  for (const provider of Object.values(config.providers)) {
    provider.apiKeyConfigured = Boolean(providerKey(provider));
  }
  return config;
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
    const apiKeyEnv = String(provider.apiKeyEnv || defaultApiKeyEnv(key)).trim();
    if (!/^MIRAI_PROVIDER_[A-Z0-9_]+_API_KEY$/.test(apiKeyEnv)) throw new TypeError(`${key} 的 API Key 环境变量名不正确`);
    providers[key] = {
      label: String(provider.label || key).trim().slice(0, 80) || key,
      type: 'openai-compatible',
      baseUrl,
      apiKeyEnv,
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
  const source = raw && typeof raw === 'object' ? raw : {};
  const secrets = {};
  for (const [name, provider] of Object.entries(source.providers || {})) {
    if (typeof provider?.apiKey === 'string' && provider.apiKey.trim()) {
      secrets[String(provider.apiKeyEnv || defaultApiKeyEnv(name))] = provider.apiKey.trim();
    }
  }
  const config = normalizeProviderConfig(source);
  if (Object.keys(secrets).length) writeDotEnvValues(secrets);
  const target = runtimePath || DEFAULT_PROVIDERS_PATH;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2));
  providerCache = null;
  activeProviderName = null;
  return getProviderConfig();
}

function setRuntimePath(filePath) {
  runtimePath = filePath || null;
  providerCache = null;
  activeProviderName = null;
}

function setDotEnvPath(filePath) {
  dotenv.setPath(filePath);
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
      headers: authorizationHeaders(provider),
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
    const temporaryApiKey = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '';
    const config = normalizeProviderConfig({ activeProvider: 'test', providers: { test: provider } });
    const candidate = config.providers.test;
    const response = await fetch(`${candidate.baseUrl}/models`, {
      headers: temporaryApiKey ? { Authorization: `Bearer ${temporaryApiKey}` } : authorizationHeaders(candidate),
      signal: AbortSignal.timeout(6000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function providerKey(provider) {
  const env = loadDotEnv();
  const k = process.env[provider.apiKeyEnv] ?? env[provider.apiKeyEnv] ?? '';
  return k && k !== 'none' && k !== 'EMPTY' && k !== 'empty';
}

function authorizationHeaders(provider) {
  if (!providerKey(provider)) return {};
  const env = loadDotEnv();
  const apiKey = process.env[provider.apiKeyEnv] ?? env[provider.apiKeyEnv];
  return { Authorization: `Bearer ${apiKey}` };
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
  const personalityConfig = loadConfig();
  const memoryContext = typeof options.memoryContext === 'string' ? options.memoryContext.trim() : '';
  const stateText = typeof options.state === 'string' ? options.state : '';
  const sys = prompts.buildChatSystemPrompt(personalityConfig, memoryContext, stateText);

  // 追加当前用户输入到记忆（仅作为请求的一部分，不在请求成功前改动持久 history，
  // 避免请求失败时留下未配对的 user 消息，导致后续对话乱序/重复）。
  const userMessage = { role: 'user', content: String(userInput) };
  const pendingHistory = [...history, userMessage];
  // 上下文 token 预算：主要截断依据（来自上下文设置面板滑条）
  const contextMaxTokens = Number.isFinite(Number(options.contextMaxTokens)) && Number(options.contextMaxTokens) > 0
    ? Math.round(Number(options.contextMaxTokens))
    : DEFAULT_CONTEXT_MAX_TOKENS;
  // 上下文压缩（AGENTS 偏好）：历史占用达预算 80% 时，把早期对话压成紧凑摘要注入，
  // 而不是等到逼近上限才截断丢弃。压缩失败时安全回退到硬截断。
  const compressThreshold = Math.round(contextMaxTokens * COMPRESSION_RATIO);
  const estimatedTotal = pendingHistory.reduce((s, m) => s + estimateTokens(String(m.content || '')), 0);
  let trimmedHistory;
  let compressed = false;
  if (pendingHistory.length >= 4 && estimatedTotal > compressThreshold) {
    try {
      const result = await buildCompressedHistory(pendingHistory, contextMaxTokens, providerConf);
      trimmedHistory = result.messages;
      compressed = result.summarizedTurns > 0;
    } catch (error) {
      console.warn(`[LLM] 上下文压缩失败，回退截断: ${error.message}`);
      trimmedHistory = truncateHistory(pendingHistory, contextMaxTokens).messages;
    }
  } else {
    trimmedHistory = truncateHistory(pendingHistory, contextMaxTokens).messages;
  }
  if (compressed) {
    console.log(`[LLM] ${provider} 上下文压缩: 历史占用 ${Math.round((100 * estimatedTotal) / contextMaxTokens)}%（阈值 ${COMPRESSION_RATIO * 100}%），将早期 ${(trimmedHistory.length - 1) / 2 | 0} 条之前的对话压成摘要，保留最近 ${trimmedHistory.length - 1} 条`);
  }

  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, authorizationHeaders(providerConf));

  const stream = typeof options.onDelta === 'function';
  const body = {
    model: providerConf.defaultModel,
    messages: [
      { role: 'system', content: sys },
      ...trimmedHistory,
    ],
    temperature: providerConf.temperature ?? 0.8,
    top_p: providerConf.topP ?? 0.9,
    stream,
  };

  console.log(`[LLM] ${provider} chat request: ${base}/chat/completions model=${providerConf.defaultModel} history=${trimmedHistory.length} contextMax=${contextMaxTokens} stream=${stream}`);
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

// 生成一句不带上下文的点击回应，不进入多轮历史
async function generatePetLine({ provider, purpose = 'click' } = {}) {
  loadProviders();
  const name = provider || activeProviderName;
  const providerConf = providerCache.providers[name];
  if (!providerConf) throw new Error(`未找到 Provider: ${name}`);
  const sys = prompts.buildPetLineSystemPrompt(loadConfig(), purpose, typeof options.state === 'string' ? options.state : '');

  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, authorizationHeaders(providerConf));
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

// 生成与聊天历史隔离的日记正文。调用者只传 Core 已保存的事实素材，避免将未经验证的推断写回长期记忆。
async function generateDiary(material, { provider } = {}) {
  loadProviders();
  const name = provider || activeProviderName;
  const providerConf = providerCache.providers[name];
  if (!providerConf) throw new Error(`未找到 Provider: ${name}`);
  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, authorizationHeaders(providerConf));
  const source = JSON.stringify(material || {}, null, 0).slice(0, 18000);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: providerConf.defaultModel,
      messages: [
        { role: 'system', content: prompts.buildDiarySystemPrompt(loadConfig()) },
        { role: 'user', content: `日记事实素材：\n${source}` },
      ],
      temperature: providerConf.temperature ?? 0.8,
      top_p: providerConf.topP ?? 0.9,
      stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM responded ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const prose = (data.choices?.[0]?.message?.content || '').trim().slice(0, 6000);
  if (!prose) throw new Error('日记生成结果为空');
  return prose;
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

// 把一段文字翻成目标语言（用于“中文回复、外语朗读”）：复用当前活跃 provider，非流式、不入历史。
// targetLang: 'ja' → 日语, 'en' → 英语 … 失败返回 null（上层可选择性兜底）。
async function translate(text, targetLang = 'ja') {
  loadProviders();
  const provider = activeProviderName;
  const providerConf = providerCache.providers[provider];
  if (!providerConf) return null;
  const base = providerConf.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, authorizationHeaders(providerConf));
  const sys = prompts.buildTranslationSystemPrompt(targetLang);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: providerConf.defaultModel,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: String(text) },
        ],
        temperature: 0.4,
        top_p: 0.9,
        stream: false,
      }),
      signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = (data.choices?.[0]?.message?.content || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

module.exports = {
  loadProviders,
  getProviderConfig,
  saveProviderConfig,
  setRuntimePath,
  setDotEnvPath,
  loadDotEnv,
  defaultApiKeyEnv,
  providerChain,
  isAvailable,
  checkProvider,
  authorizationHeaders,
  generateReply,
  generatePetLine,
  generateDiary,
  translate,
  resetConversationHistory,
  estimateTokens,
  truncateHistory,
  buildCompressedHistory,
};
