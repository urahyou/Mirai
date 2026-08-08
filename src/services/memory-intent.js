const MEMORY_LABELS = Object.freeze({
  profile: '资料',
  preference: '偏好',
  episodic: '事件',
  relationship: '关系',
  work: '工作',
  schedule: '日程',
});

function stripQuote(text) {
  return text.replace(/["'「」『』“”‘’]/g, '').trim();
}

function afterFirst(text, candidates) {
  let rest = text;
  for (const candidate of candidates) {
    const index = rest.indexOf(candidate);
    if (index >= 0) { rest = rest.slice(index + candidate.length); break; }
  }
  return rest;
}

function cleanLeading(text) {
  return text
    .replace(/^(关于|我|我的|就|就是|嗯|好的|把|这些|那些|那条|这个|刚才的|帮我|请)\s*(内容|信息|话|事)?\s*/, '')
    .trim();
}

function inferType(text) {
  if (/(名字|叫|年龄|生日|生日|住|住在|地址|公司|家在)/.test(text)) return 'profile';
  if (/(喜欢|爱吃|喜欢|讨厌|口味|爱好|早餐|喝|吃)/.test(text)) return 'preference';
  if (/(会议|约会|预约|提醒|明天|后天|几点|日程|周[一二三四五六日天])/.test(text)) return 'schedule';
  if (/(工作|项目|任务|代码|文件|团队|需求)/.test(text)) return 'work';
  return 'episodic';
}

/**
 * 把一句话映射为记忆操作意图。
 * 返回 { kind, content?, type? }；kind ∈ remember|forget|doNotRemember|recall|none。
 * 优先顺序：回查 → 拒绝记忆 → 忘记 → 记住，保证子串互不冲突。
 */
function parseMemoryIntent(raw) {
  if (typeof raw !== 'string') return { kind: 'none' };
  const text = raw.trim();
  if (!text) return { kind: 'none' };

  const recallTokens = ['你记得什么', '你记住什么', '你记了什么', '我告诉过你什么', '你想起什么'];
  if (recallTokens.some((token) => text.includes(token))) return { kind: 'recall' };

  const forbidMatch = text.match(/不要记住|别记住|不用记住|不要记|别记|别提醒/);
  if (forbidMatch) {
    const content = cleanLeading(matrixContent(stripQuote(text.slice(text.indexOf(forbidMatch[0]) + forbidMatch[0].length))));
    if (content.length >= 2) return { kind: 'doNotRemember', content, type: inferType(content) };
  }

  const forgetMatch = text.match(/忘记|忘掉|忘了|删掉记忆|删除记忆/);
  if (forgetMatch) {
    const content = cleanLeading(matrixContent(afterFirst(text, [forgetMatch[0]])));
    if (content.length >= 2) return { kind: 'forget', content, type: inferType(content) };
    return { kind: 'forget', content: null };
  }

  // 「把X记下来」句式：内容是动词之前的「X」
  const framed = text.match(/(?:把|帮我把)([^,，。;；]{1,40}?)(?:记下来|记住|记好|记着|记下|记录)/);
  if (framed) {
    const content = cleanLeading(matrixContent(stripQuote(framed[1])));
    if (content.length >= 2) return { kind: 'remember', content, type: inferType(content) };
  }

  const rememberMatch = text.match(/记住|记下来|记一下|帮我记|记着/);
  if (rememberMatch) {
    const index = text.indexOf(rememberMatch[0]);
    const content = cleanLeading(matrixContent(stripQuote(text.slice(index + rememberMatch[0].length))));
    if (content.length >= 2) return { kind: 'remember', content, type: inferType(content) };
  }

  return { kind: 'none' };
}

function matrixContent(text) {
  return text
    .replace(/^(就|要|需要|帮我|记住|记好|记一下|这个|这些|那是|是|关于|总之|一下)\s*/, '')
    .replace(/[。！；;]$/, '')
    .trim();
}

module.exports = { parseMemoryIntent, inferType, MEMORY_LABELS };