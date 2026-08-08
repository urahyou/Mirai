const { loadConfig } = require('./rules');

// Ollama 本地大模型接入
// 通过 ollama 的 HTTP API (http://localhost:11434) 生成回复

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
let DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b';

function getModel() {
  return DEFAULT_MODEL;
}

function setModel(name) {
  DEFAULT_MODEL = name;
}

/**
 * 检查 Ollama 是否可用
 */
async function isAvailable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 列出已安装模型
 */
async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error('Ollama API error');
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/**
 * 生成单轮对话回复（不带记忆，简单实现）
 * @param {string} userInput 用户输入
 * @returns {Promise<string>}
 */
async function generateReply(userInput, { model = getModel() } = {}) {
  const { systemPrompt, personality } = loadConfig();
  // 注入人格信息
  const sys = systemPrompt.replace('{personality}', JSON.stringify(personality, null, 0));

  const body = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: String(userInput) },
    ],
    stream: false,
    options: {
      temperature: 0.8,
      top_p: 0.9,
    },
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama responded ${res.status}`);
  }

  const data = await res.json();
  return (data.message?.content || '').trim();
}

module.exports = { generateReply, isAvailable, listModels, getModel, setModel, DEFAULT_MODEL };
