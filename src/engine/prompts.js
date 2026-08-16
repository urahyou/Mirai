// Prompt 文件加载器。每个可编辑 Prompt 独立存放在 src/prompts/*.md。
// Graphiti 的实体抽取 Prompt 由 graphiti-core 内部维护，不属于 Mirai 模板。

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const LANGUAGE_NAMES = Object.freeze({ ja: '日语', en: '英语', ko: '韩语', zh: '中文' });

function readPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8').trim();
}

function render(template, variables = {}) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => String(variables[key] ?? ''));
}

function personalityText(config) {
  return JSON.stringify(config, null, 0);
}

function buildChatSystemPrompt(config, memoryContext = '') {
  return render(readPrompt('chat'), {
    personality: personalityText(config),
    memory_context: memoryContext,
  });
}

function buildPetLineSystemPrompt(config, purpose = 'click') {
  const promptName = purpose === 'click' ? 'pet-line-click' : 'pet-line-click';
  return render(readPrompt(promptName), { personality: personalityText(config) });
}

function buildTranslationSystemPrompt(targetLang = 'ja') {
  return render(readPrompt('translation'), {
    language: LANGUAGE_NAMES[targetLang] || targetLang,
  });
}

module.exports = Object.freeze({
  LANGUAGE_NAMES,
  buildChatSystemPrompt,
  buildPetLineSystemPrompt,
  buildTranslationSystemPrompt,
  readPrompt,
});
