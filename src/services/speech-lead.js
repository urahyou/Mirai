// 流式回复的首句抢跑：先说首个完整句，回复结束后只补未朗读的尾部。
module.exports = function createSpeechLead({ speak, minChars = 6 }) {
  let prefix = '';
  let started = false;
  function observe(fullText) {
    if (started) return '';
    const text = String(fullText || '');
    const match = new RegExp(`^([\\s\\S]{${Math.max(1, minChars)},}?[。！？!?；;])`).exec(text);
    if (!match) return '';
    prefix = match[1];
    started = true;
    speak(prefix);
    return prefix;
  }
  function finish(fullText) {
    const text = String(fullText || '').trim();
    const remaining = (prefix ? text.slice(prefix.length) : text).trim();
    if (remaining) speak(remaining);
    return remaining;
  }
  return { observe, finish, spokenPrefix: () => prefix };
};
