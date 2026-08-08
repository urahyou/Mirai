const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBasePrompt } = require('../src/engine/generic');

test('Given a bounded memory context When generating the base prompt Then it is flagged as possibly-relevant historical info, never asserted fact', () => {
  const prompt = buildBasePrompt({
    system: '你是小未来。',
    emotionState: null,
    memoryContext: '[preference] 用户喜欢美式咖啡',
  });
  assert.match(prompt, /可能是与本次对话相关的历史信息/);
  assert.match(prompt, /喜欢美式咖啡/);
});

test('Given no memory context Then the base prompt omits any memory section', () => {
  const prompt = buildBasePrompt({ system: '你是小未来。', emotionState: null, memoryContext: null });
  assert.equal(prompt, '你是小未来。');
});

test('Given an emotion snapshot Then it is injected as a tone hint without exposing numbers as dialog', () => {
  const prompt = buildBasePrompt({
    system: '你是小未来。',
    emotionState: { mood: 'happy', affection: 60 },
    memoryContext: '',
  });
  assert.match(prompt, /当前情感状态/);
  assert.match(prompt, /"mood":"happy"/);
});