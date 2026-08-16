const assert = require('node:assert/strict');
const test = require('node:test');
const prompts = require('../src/engine/prompts');

test('prompts: buildChatSystemPrompt 渲染 personality/memory_context/state', () => {
  const config = { name: '小未来', motto: 'hello' };
  const out = prompts.buildChatSystemPrompt(config, '记忆：主人喜欢猫。', '心情：开心(70/100)\n对主人好感：50/100');
  assert.ok(out.includes('小未来'), 'personality 注入');
  assert.ok(out.includes('记忆：主人喜欢猫。'), 'memory_context 注入');
  assert.ok(out.includes('心情：开心') && out.includes('好感'), 'state 注入');
  assert.ok(!out.includes('{{state}}') && !out.includes('{{personality}}') && !out.includes('{{memory_context}}'), '无残留占位符');
});

test('prompts: 缺省参数为空串不崩溃、不留占位符', () => {
  const out = prompts.buildChatSystemPrompt({ name: 'x' });
  assert.ok(!out.includes('{{'), '无残留占位符');
});

test('prompts: buildPetLineSystemPrompt 渲染 state', () => {
  const out = prompts.buildPetLineSystemPrompt({ name: 'x' }, 'click', '心情：平静(60/100)');
  assert.ok(out.includes('心情：平静'), 'pet-line 注入 state');
  assert.ok(!out.includes('{{state}}'));
});
