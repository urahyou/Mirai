// 解析 LLM 回复中的舞台提示。
// 括号里的短文本只交给表现层，不能进入气泡、聊天记录或 TTS。
function parseResponseMarkup(raw) {
  const cues = [];
  const source = String(raw || '');
  const text = source.replace(/[（(]([^（）()\n]{1,120})[）)]/g, (whole, cue) => {
    const value = String(cue || '').trim();
    if (!value) return '';
    const looksLikeCue = /[点头摇头挥手鞠躬微笑笑哭眨眼看向低头抬头脸红害羞兴奋开心难过生气惊讶困倦撒娇害怕紧张]/u.test(value)
      || /^(?:nod|smile|smiles|wave|bow|blush|laugh|cry|sigh|looks?\b|excited\b|happy\b|sad\b)/i.test(value);
    if (!looksLikeCue) return whole;
    cues.push(value);
    return '';
  }).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, cues };
}

module.exports = { parseResponseMarkup };
