const assert = require('node:assert/strict');
const test = require('node:test');
const { parseResponseMarkup } = require('../src/services/response-markup');

test('response markup removes Chinese stage directions from spoken text', () => {
  const parsed = parseResponseMarkup('（兴奋地点头）嗯嗯！他家的奶油面包可好吃了！');
  assert.equal(parsed.text, '嗯嗯！他家的奶油面包可好吃了！');
  assert.deepEqual(parsed.cues, ['兴奋地点头']);
});

test('response markup preserves ordinary parenthetical content', () => {
  const parsed = parseResponseMarkup('这个版本（v2）还不错。');
  assert.equal(parsed.text, '这个版本（v2）还不错。');
  assert.deepEqual(parsed.cues, []);
});
