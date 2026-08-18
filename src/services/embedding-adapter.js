const dotenv = require('./dotenv');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BATCH_SIZE = 16;
const MAX_TEXT_LENGTH = 4000;

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeConfig(values) {
  const source = values && typeof values === 'object' ? values : {};
  const isEnabled = enabled(source.MIRAI_EMBEDDING_ENABLED);
  const baseUrl = String(source.MIRAI_EMBEDDING_BASE_URL || '').trim().replace(/\/$/, '');
  const model = String(source.MIRAI_EMBEDDING_MODEL || '').trim().slice(0, 160);
  const endpoint = baseUrl.endsWith('/embeddings') ? baseUrl : `${baseUrl}/embeddings`;
  const timeout = Number.parseInt(source.MIRAI_EMBEDDING_TIMEOUT_MS, 10);
  return {
    enabled: isEnabled,
    ready: isEnabled && /^https?:\/\//.test(baseUrl) && Boolean(model),
    baseUrl,
    endpoint,
    model,
    apiKey: String(source.MIRAI_EMBEDDING_API_KEY || '').trim(),
    timeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.min(60000, timeout)) : DEFAULT_TIMEOUT_MS,
  };
}

module.exports = function createEmbeddingAdapter({ readEnv = () => dotenv.readAll(), fetchImpl = (...args) => fetch(...args) } = {}) {
  function config() {
    return normalizeConfig(readEnv());
  }

  function getStatus() {
    const current = config();
    return {
      enabled: current.enabled,
      ready: current.ready,
      model: current.model,
      endpoint: current.ready ? current.endpoint : '',
    };
  }

  async function embed(input) {
    const texts = (Array.isArray(input) ? input : [input])
      .map((text) => String(text || '').trim().slice(0, MAX_TEXT_LENGTH));
    if (!texts.length || texts.some((text) => !text)) throw new TypeError('embedding 输入必须是非空文本');
    if (texts.length > MAX_BATCH_SIZE) throw new RangeError(`embedding 单批最多 ${MAX_BATCH_SIZE} 条`);
    const current = config();
    if (!current.enabled) throw new Error('embedding 未启用');
    if (!current.ready) throw new Error('embedding 配置不完整');
    const headers = { 'Content-Type': 'application/json' };
    if (current.apiKey) headers.Authorization = `Bearer ${current.apiKey}`;
    const response = await fetchImpl(current.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: current.model, input: texts }),
      signal: AbortSignal.timeout(current.timeoutMs),
    });
    if (!response.ok) throw new Error(`embedding 服务返回 HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data) || body.data.length !== texts.length) throw new Error('embedding 响应数量不匹配');
    const ordered = Array(texts.length);
    for (const item of body.data) {
      const index = Number(item?.index);
      if (!Number.isInteger(index) || index < 0 || index >= texts.length || ordered[index]) {
        throw new Error('embedding 响应序号不合法');
      }
      ordered[index] = item;
    }
    const vectors = ordered.map((item) => item.embedding);
    const dimensions = vectors[0]?.length;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) throw new Error('embedding 响应维数不合法');
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('embedding 响应向量不合法');
      }
    }
    return { model: current.model, dimensions, vectors };
  }

  return { getStatus, embed };
};

module.exports.normalizeConfig = normalizeConfig;
