// 尽力而为的“模型最大上下文”探测。
// 不同后端暴露方式不同：
//   - Ollama:  /api/tags 与 /api/show -> model_info.context_length
//   - LM Studio / llama.cpp 有些版本 /v1/models 带 context_length / meta
//   - OpenAI 官方 /models 不提供 → 探测失败返回 null，UI 让用户手动设置
// 探测失败不应报错，调用方用 null 表示“未知上限”，回退到软上限。

// 常见字段名，按优先级尝试（后缀匹配，覆盖命名空间键如 general.context_length、llama.context_length）
const CONTEXT_SUFFIXES = ['context_length', 'max_context_length', 'max_context', 'max_position_embeddings', 'context_window', 'max_model_len'];

function looksLikeContextValue(v) {
  return Number.isFinite(v) && v > 0 && v < 1e9;
}

// 深度扫描对象：优先精确字段，其次递归找任意“以 context 相关关键字结尾”的键。
// 返回第一个合理的正整数值。
function extractContextLength(obj, _seen) {
  if (!obj || typeof obj !== 'object') return null;
  const seen = _seen || new Set();
  if (seen.has(obj)) return null;
  seen.add(obj);

  const stack = [{ node: obj, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object' && depth < 5) {
        if (!seen.has(val)) { seen.add(val); stack.push({ node: val, depth: depth + 1 }); }
      } else {
        const lowerKey = key.toLowerCase();
        if (CONTEXT_SUFFIXES.some((s) => lowerKey.endsWith(s))) {
          if (looksLikeContextValue(val)) return Math.round(val);
        }
      }
    }
  }
  return null;
}

// 判断 baseUrl 是否像 Ollama（端口 11434 且不带 /v1）
function looksLikeOllama(baseUrl) {
  return /:11434(\/|$)/.test(baseUrl);
}

async function fetchJson(url, headers, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

/**
 * 探测一个 provider 当前激活模型的上下文窗口长度。
 * @param {object} provider 归一化后的 provider 配置（baseUrl/apiKeyEnv/defaultModel）
 * @param {(provider) => object} [getHeaders] 返回请求头（含鉴权）。默认无鉴权。
 * @returns {Promise<number|null>} 上下文 token 数；未知返回 null
 */
async function probeMaxContext(provider, getHeaders) {
  if (!provider || !provider.baseUrl) return null;
  const rawBase = String(provider.baseUrl).replace(/\/+$/, '');
  const headers = typeof getHeaders === 'function' ? (getHeaders(provider) || {}) : {};
  const model = provider.defaultModel;

  // 1) Ollama：/api/tags + /api/show（都在根路径，不带 /v1）
  if (looksLikeOllama(rawBase)) {
    const root = rawBase.replace(/\/v1$/, '').replace(/\/+$/, '') || rawBase;
    // /api/tags 列表：优先当前默认模型
    const listData = await fetchJson(`${root}/api/tags`, {}, 3000);
    const models = Array.isArray(listData?.models) ? listData.models : [];
    if (models.length) {
      const exact = models.find((m) => m.name === model || m.name?.startsWith(model.split(':')[0] + ':'))
        || models.find((m) => m.name === model);
      const len = extractContextLength(exact);
      if (len) return len;
    }
    // 没有 -> /api/show 精确查询
    try {
      const res = await fetch(`${root}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const len = extractContextLength(data?.model_info) ?? extractContextLength(data);
        if (len) return len;
      }
    } catch { /* ignore */ }
  }

  // 2) 通用 OpenAI 兼容 /v1/models：列表 + 单对象都试
  const data = await fetchJson(`${rawBase}/models`, headers, 3000);
  const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  const exact = list.find((m) => m.id === model || m.name === model);
  const exactLen = extractContextLength(exact);
  if (exactLen) return exactLen;
  for (const m of list) {
    const len = extractContextLength(m);
    if (len) return len;
  }

  return null;
}

module.exports = { probeMaxContext };
