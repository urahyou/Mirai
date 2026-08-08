// 方案 C — P2：自动沉淀 Memory Judge。
// 对话拿到回复后，后台让本地 LLM 判断「这轮有没有值得长期记住的信息」，
// 输出结构化候选，经保守后处理过滤后按层写入长期记忆。
//
// 设计原则（对齐 Cyrene MemoryJudge）：宁可漏记，不要误记。
// - 只记用户明确表达的、未来确实有帮助的信息
// - 禁止把推断写成确定事实；禁止把一次性状态写成长期偏好
// - 过度概括 / 绝对化措辞而用户没说 / 无依据推断 → 挡掉

const { completion } = require('../engine/generic');

const MEMORY_TYPES = new Set(['profile', 'preference', 'episodic', 'relationship', 'work', 'schedule']);

// 绝对化措辞：除非用户原话明确说过，否则判为过度概括，不得作为稳定画像。
// 注意「只」同时是中文量词（一只猫/是只橘猫）与绝对化副词（只吃素），
// 所以必须配合原文判定：绝对词需在用户原话中出现过才放行，避免误杀量词用法。
const ABSOLUTE_TERMS = ['永远', '从不', '一定', '完全', '绝对', '以后都', '不再', '只'];

const JUDGE_SYSTEM = [
  '你是一个「保守的记忆候选提取器」，不是事实裁判，也不是用户画像改写器。',
  '你的目标是少记错，不是多记住。',
  '只能提取用户明确表达、且未来确实有帮助的信息。',
  '如果这段对话没有值得长期记的内容，必须只输出 {"candidates":[]}，别无他物。',
  '',
  '规则：',
  '- 纯日常问候、闲聊、情绪发泄（无信息量）→ 返回空 candidates',
  '- 必须是用户主动表达的信息，不是 AI 说的；AI 的建议/安慰/总结不要写成用户事实',
  '- 禁止把推断写成确定事实；禁止把一次性状态写成长期偏好',
  '- 不要把「这次/刚刚/这个话题里」推广成长期偏好',
  '- 不要自动使用绝对化表达（只/永远/从不/一定/完全/绝对/以后都/不再），除非用户原话明确说过',
  '',
  '输出必须是顶层 JSON 对象，唯一字段为 candidates（数组）。每个候选：',
  '{',
  '  "type": "profile|preference|episodic|relationship|work|schedule",',
  '  "content": "要记住的简短事实（忠于用户原话，不推广范围）",',
  '  "importance": 0.0~1.0,',
  '  "confidence": 0.0~1.0,',
  '  "stability": "one_off|situational|stable",',
  '  "certainty": "explicit|inferred|uncertain",',
  '  "shouldWrite": true/false,',
  '  "reason": "为什么值得记，或不记"',
  '}',
  '没有值得记的信息时输出 {"candidates":[]}。',
].join('\n');

function toScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const content = String(candidate.content || '').trim();
  const type = String(candidate.type || '').trim();
  if (!content || !MEMORY_TYPES.has(type)) return null;
  return {
    type,
    content,
    importance: toScore(candidate.importance),
    confidence: toScore(candidate.confidence),
    stability: ['one_off', 'situational', 'stable'].includes(candidate.stability) ? candidate.stability : 'situational',
    certainty: ['explicit', 'inferred', 'uncertain'].includes(candidate.certainty) ? candidate.certainty : 'inferred',
    shouldWrite: candidate.shouldWrite !== false,
  };
}

function hasUnsupportedAbsolute(summary, sourceText) {
  return ABSOLUTE_TERMS.some((term) =>
    summary.includes(term) && !(typeof sourceText === 'string' && sourceText.includes(term))
  );
}

// 业务后处理：过滤不符合条件的候选（对齐 Cyrene postFilterCandidates）
// sourceText 为用户原话，用于豁免「用户自己明确说过的绝对化表达」；
// 从而区分量词「一只猫」与副词「只吃素」。
function postFilterCandidates(candidates, sourceText) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(normalizeCandidate)
    .filter(Boolean)
    .filter((item) => item.shouldWrite === true)
    .filter((item) => !hasUnsupportedAbsolute(item.content, sourceText));
}

// 决定归属层：稳定且明确的身份/偏好才进 core，其余进 archival（active）
function layerFor(item) {
  return item.certainty === 'explicit' && item.stability === 'stable' && item.importance >= 0.8 && item.confidence >= 0.8
    ? 'core'
    : 'active';
}

// 从未知文本中提取首个顶层 { candidates: [...] } 数组
function extractJsonCandidates(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}

// 单轮提炼：返回过滤后的候选列表（纯函数，便于测试）
async function extractCandidates({ userInput, assistantReply, provider } = {}) {
  const transcript = [
    '最近一轮对话：',
    `用户：${String(userInput || '')}`,
    `小未来：${String(assistantReply || '')}`,
    '',
    '请判断有没有值得长期记住的信息，并按要求输出 JSON。',
  ].join('\n');
  const raw = await completion({ system: JUDGE_SYSTEM, user: transcript, provider });
  return postFilterCandidates(extractJsonCandidates(raw), `${userInput || ''} ${assistantReply || ''}`);
}

// 主入口：提炼并写入长期记忆，返回写入条数；任何失败返回 0（调用方静默）
async function run({ service, userInput, assistantReply, provider, onJudged } = {}) {
  if (!service || !userInput || !assistantReply) return 0;
  let candidates;
  try {
    candidates = await extractCandidates({ userInput, assistantReply, provider });
  } catch (err) {
    console.log('[memory-judge] llm failed, skipped:', err && err.message);
    onJudged && onJudged({ kind: 'skipped', reason: 'llm' });
    return 0; // LLM 不可用/失败 → 静默，绝不阻塞对话
  }
  console.log(`[memory-judge] candidate count: ${candidates.length}`);
  if (candidates.length === 0) {
    onJudged && onJudged({ kind: 'none' });
    return 0;
  }

  let written = 0;
  for (const item of candidates) {
    try {
      const stored = service.remember({
        type: item.type,
        content: item.content,
        importance: item.importance,
        confidence: item.confidence,
        status: layerFor(item),
        explicit: true,
        source: 'judge',
      });
      if (stored) {
        written += 1;
        console.log(`[memory-judge] wrote ${layerFor(item)}/${item.type}: ${item.content.slice(0, 40)}`);
        onJudged && onJudged({ kind: 'wrote', id: stored.id, type: item.type, content: item.content });
      }
    } catch {
      // 单条失败不影响其余
    }
  }
  return written;
}

module.exports = {
  run,
  extractCandidates,
  extractJsonCandidates,
  normalizeCandidate,
  postFilterCandidates,
  layerFor,
  JUDGE_SYSTEM,
};
