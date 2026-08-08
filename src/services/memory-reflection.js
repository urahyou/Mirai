// P3 反思压缩调度器
// 把 archival/active 中「低热度 + 久未访问」的旧记忆交给 LLM 压成摘要，原始条标 compressed。
// 保护：accessCount 高、status=core、isSummary 摘要条、已删条 不压。
// 纯 LLM（走 generic.completion），无新依赖；LLM 不可用时静默跳过，绝不阻塞。

const { completion } = require('../engine/generic');

const REFLECT_SYSTEM_PROMPT =
  '你是记忆压缩助手。把下面多条关于同一主题的记忆，压缩成一条简洁、准确、可独立理解的摘要。' +
  '只输出摘要正文，不要编号、不要前缀、不要解释。保留关键信息，丢弃纯重复细节。';

/**
 * 选材（纯函数，可在无 LLM 环境下测试）：
 * 返回被选中的记忆对象数组（按「同类优先 + 最久未访问」排序，最多 maxCount）。
 */
function selectCandidates(service, { now = new Date(), minAgeMs = 7 * 86400000, maxCount = 3, minCount = 2 } = {}) {
  const all = (service.list && service.list({ includeArchived: true })) || [];
  // 候选：非 summary / 非 compressed / 非 core / 非已删
  const candidates = all.filter((m) =>
    !m.isSummary && m.status !== 'core' && m.status !== 'compressed' && !m.deletedAt);
  // 久未访问
  const aged = candidates.filter((m) => {
    const last = m.lastAccessedAt ? new Date(m.lastAccessedAt).getTime() : 0;
    return (now.getTime() - last) >= minAgeMs;
  });
  // 保护：accessCount 高不压
  const low = aged.filter((m) => (m.accessCount || 0) <= 2);
  if (low.length < minCount) return [];

  // 同类优先：找最大的同 type 组
  const byType = new Map();
  for (const m of low) {
    if (!byType.has(m.type)) byType.set(m.type, []);
    byType.get(m.type).push(m);
  }
  let group = [];
  for (const arr of byType.values()) {
    if (arr.length > group.length) group = arr;
  }
  // 组内按最久未访问优先
  group = group.slice().sort((a, b) => {
    const la = a.lastAccessedAt ? new Date(a.lastAccessedAt).getTime() : 0;
    const lb = b.lastAccessedAt ? new Date(b.lastAccessedAt).getTime() : 0;
    return la - lb;
  });
  return group.slice(0, maxCount);
}

/**
 * 执行一轮反思压缩。返回压缩的原始条数；无可压缩/LLM 失败返回 0。
 * completion 可注入（测试用 mock），默认走 generic.completion。
 */
async function runReflection({ service, provider, completionFn = completion, now = new Date(), minAgeMs, maxCount } = {}) {
  if (!service) return 0;
  const picks = selectCandidates(service, { now, minAgeMs, maxCount });
  if (picks.length < 2) return 0;

  const lines = picks.map((m) => `- [${m.type}] ${m.content}`).join('\n');
  let summaryText;
  try {
    summaryText = await completionFn({
      system: REFLECT_SYSTEM_PROMPT,
      user: `请压缩以下记忆为一条摘要：\n${lines}`,
      provider,
      temperature: 0.4,
    });
  } catch {
    console.log('[memory-reflection] llm failed, skipped');
    return 0;
  }
  const text = String(summaryText || '').trim();
  if (!text) return 0;

  const result = service.reflect({
    ids: picks.map((p) => p.id),
    content: text,
    type: picks[0].type,
    importance: Math.max(...picks.map((p) => p.importance || 0)),
    confidence: Math.min(...picks.map((p) => (p.confidence == null ? 1 : p.confidence))),
    source: 'reflection',
  });
  if (!result) return 0;
  console.log(`[memory-reflection] compressed ${picks.length} -> summary: ${text.slice(0, 40)}`);
  return picks.length;
}

module.exports = { selectCandidates, runReflection };
