const fs = require('fs');
const path = require('path');

const DOTENV_PATH = path.join(__dirname, '..', '..', '.env');
const DEFAULTS = Object.freeze({
  GRAPHITI_ENABLED: 'false',
  GRAPHITI_BASE_URL: 'http://127.0.0.1:8766',
  GRAPHITI_GROUP_ID: 'mirai-owner',
  GRAPHITI_NEO4J_URI: 'bolt://127.0.0.1:7687',
  GRAPHITI_NEO4J_USER: 'neo4j',
  GRAPHITI_NEO4J_PASSWORD: '',
  GRAPHITI_NEO4J_DATABASE: 'neo4j',
  GRAPHITI_LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  GRAPHITI_LLM_API_KEY: '',
  GRAPHITI_LLM_MODEL: '',
  GRAPHITI_LLM_SMALL_MODEL: '',
  GRAPHITI_LLM_MAX_TOKENS: '2048',
  GRAPHITI_OLLAMA_THINK: 'false',
  GRAPHITI_EMBED_BASE_URL: 'http://127.0.0.1:11434/v1',
  GRAPHITI_EMBED_API_KEY: '',
  GRAPHITI_EMBED_MODEL: 'bge-m3',
  GRAPHITI_EPISODE_TIMEOUT: '120',
  GRAPHITI_SEARCH_TIMEOUT: '30',
});
const PANEL_KEYS = Object.keys(DEFAULTS);
const REQUEST_TIMEOUT_MS = 8000;

function requestTimeoutMs(pathname) {
  const values = getSettings();
  if (pathname === '/episode') return (Number(values.GRAPHITI_EPISODE_TIMEOUT) || 120) * 1000 + 5000;
  if (pathname === '/search') return (Number(values.GRAPHITI_SEARCH_TIMEOUT) || 30) * 1000 + 5000;
  return REQUEST_TIMEOUT_MS;
}

function loadDotEnv() {
  try {
    const values = {};
    for (const rawLine of fs.readFileSync(DOTENV_PATH, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function env(name, values = loadDotEnv()) { return process.env[name] ?? values[name] ?? ''; }

function getSettings() {
  const values = { ...DEFAULTS, ...loadDotEnv() };
  for (const key of PANEL_KEYS) if (process.env[key] !== undefined) values[key] = process.env[key];
  return values;
}

function getConfig() {
  const values = getSettings();
  return {
    enabled: ['1', 'true', 'yes', 'on'].includes(String(values.GRAPHITI_ENABLED).toLowerCase()),
    baseUrl: String(values.GRAPHITI_BASE_URL).replace(/\/$/, ''),
    groupId: String(values.GRAPHITI_GROUP_ID).trim().slice(0, 120),
  };
}

function writeSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Graphiti 配置必须是对象');
  const allowed = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PANEL_KEYS.includes(key)) continue;
    const text = String(value ?? '').trim();
    if (text.length > 500) throw new TypeError(`${key} 配置过长`);
    allowed[key] = text;
  }
  if (!Object.keys(allowed).length) throw new TypeError('没有可保存的 Graphiti 配置');
  let raw = '';
  try { raw = fs.readFileSync(DOTENV_PATH, 'utf8'); } catch { /* create on first save */ }
  const lines = raw.split(/\r?\n/);
  for (const [key, value] of Object.entries(allowed)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(DOTENV_PATH), { recursive: true });
  fs.writeFileSync(DOTENV_PATH, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return getSettingsForPanel();
}

function getSettingsForPanel() {
  const values = getSettings();
  return { ...values,
    GRAPHITI_NEO4J_PASSWORD: values.GRAPHITI_NEO4J_PASSWORD ? 'configured' : '',
    GRAPHITI_LLM_API_KEY: values.GRAPHITI_LLM_API_KEY ? 'configured' : '',
    GRAPHITI_EMBED_API_KEY: values.GRAPHITI_EMBED_API_KEY ? 'configured' : '',
  };
}

async function request(pathname, options = {}) {
  const response = await fetch(`${getConfig().baseUrl}${pathname}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(requestTimeoutMs(pathname)),
  });
  if (!response.ok) throw new Error(`Graphiti sidecar HTTP ${response.status}`);
  return response.json();
}

async function health() {
  const config = getConfig();
  if (!config.enabled) return { ok: false, state: 'disabled' };
  try {
    return await request('/health');
  } catch (error) {
    return { ok: false, state: 'unreachable', error: String(error.message || error).slice(0, 200) };
  }
}

async function search(query) {
  const config = getConfig();
  if (!config.enabled || !String(query || '').trim()) return [];
  try {
    const payload = await request('/search', { method: 'POST', body: JSON.stringify({ query: String(query).slice(0, 2000), group_id: config.groupId }) });
    return Array.isArray(payload?.results) ? payload.results : [];
  } catch (error) {
    console.warn(`[Graphiti] search skipped: ${error.message || error}`);
    return [];
  }
}

function formatContext(results) {
  const rows = Array.isArray(results) ? results.filter((item) => item?.fact || item?.content || item?.text).slice(0, 8) : [];
  if (!rows.length) return '';
  return [
    '以下是从时序关系记忆中检索到的参考资料。请结合事实发生时间和有效期回答；不确定时不要自行补全：',
    ...rows.map((item, index) => {
      const fact = item.fact || item.content || item.text;
      const time = [item.valid_at, item.invalid_at, item.created_at].filter(Boolean).join(' 至 ');
      return `${index + 1}. ${fact}${time ? `（时间：${time}）` : ''}`;
    }),
  ].join('\n');
}

async function add(messages, referenceTime = new Date().toISOString()) {
  const config = getConfig();
  if (!config.enabled || !Array.isArray(messages) || !messages.length) return false;
  const normalized = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content || '').trim().slice(0, 4000) }))
    .filter((m) => m.content);
  if (!normalized.length) return false;
  try {
    await request('/episode', {
      method: 'POST',
      body: JSON.stringify({ group_id: config.groupId, reference_time: referenceTime, messages: normalized }),
    });
    return true;
  } catch (error) {
    console.warn(`[Graphiti] add skipped: ${error.message || error}`);
    return false;
  }
}

async function getStatus() {
  const config = getConfig();
  const healthResult = await health();
  return { ...healthResult, enabled: config.enabled, baseUrl: config.baseUrl, groupId: config.groupId };
}

module.exports = { add, formatContext, getConfig, getSettingsForPanel, getStatus, health, loadDotEnv, search, writeSettings };
