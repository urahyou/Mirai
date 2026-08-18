const assert = require('node:assert/strict');
const test = require('node:test');
const createSpeechLead = require('../src/services/speech-lead');

test('speech lead starts GPT-SoVITS with the first complete sentence and does not repeat it', () => {
  const spoken = [];
  const lead = createSpeechLead({ speak: (text) => spoken.push(text) });
  lead.observe('你好，');
  assert.deepEqual(spoken, []);
  lead.observe('你好，今天过得怎么样？后面的内容还在生成');
  assert.deepEqual(spoken, ['你好，今天过得怎么样？']);
  lead.finish('你好，今天过得怎么样？后面的内容还在生成');
  assert.deepEqual(spoken, ['你好，今天过得怎么样？', '后面的内容还在生成']);
});

test('speech lead falls back to the complete reply when no sentence arrives during streaming', () => {
  const spoken = [];
  const lead = createSpeechLead({ speak: (text) => spoken.push(text) });
  lead.observe('短句');
  lead.finish('短句');
  assert.deepEqual(spoken, ['短句']);
});

test('speech lead does not split a short acknowledgement into a queued second TTS request', () => {
  const spoken = [];
  const lead = createSpeechLead({ speak: (text) => spoken.push(text) });
  lead.observe('嗯嗯！他家的奶油面包可好吃了！');
  assert.deepEqual(spoken, ['嗯嗯！他家的奶油面包可好吃了！']);
  lead.finish('嗯嗯！他家的奶油面包可好吃了！');
  assert.deepEqual(spoken, ['嗯嗯！他家的奶油面包可好吃了！']);
});
