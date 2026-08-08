const assert = require('node:assert/strict');
const test = require('node:test');

const { parseMemoryIntent } = require('../src/services/memory-intent');

test('Given explicit memorize phrasings When parsed Then they become remember intents with inferred content and type', () => {
  assert.deepEqual(parseMemoryIntent('记住我喜欢喝美式咖啡'), {
    kind: 'remember', content: '喜欢喝美式咖啡', type: 'preference',
  });
  assert.deepEqual(parseMemoryIntent('把我订的航班记下来'), {
    kind: 'remember', content: '订的航班', type: 'episodic',
  });
  assert.deepEqual(parseMemoryIntent('帮我记一下明天要交报告'), {
    kind: 'remember', content: '明天要交报告', type: 'schedule',
  });
});

test('Given recall, forget, and decline phrasings then matched to the correct memory intent', () => {
  assert.equal(parseMemoryIntent('你记得什么').kind, 'recall');
  assert.deepEqual(parseMemoryIntent('忘记我要开会的事'), {
    kind: 'forget', content: '要开会的事', type: 'episodic',
  });
  assert.equal(parseMemoryIntent('不要记住').kind, 'none');
});

test('Given ordinary chat Then it is never mistaken for a memory command', () => {
assert.equal(parseMemoryIntent('你好，今天天气怎么样').kind, 'none');
  assert.equal(parseMemoryIntent('').kind, 'none');
  assert.equal(parseMemoryIntent(undefined).kind, 'none');
  assert.equal(parseMemoryIntent(42).kind, 'none');
  assert.equal(parseMemoryIntent('刚才提到的事回头再说').kind, 'none');
});