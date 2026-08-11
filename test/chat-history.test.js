const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const chatHistory = require('../src/services/chat-history');

test('chat history persists ordered user and assistant messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-chat-history-'));
  const file = path.join(dir, 'chat-history.json');
  chatHistory.setRuntimePath(file);

  try {
    assert.deepEqual(chatHistory.getMessages(), []);
    const user = chatHistory.appendMessage('user', '你好');
    const assistant = chatHistory.appendMessage('assistant', '主人好呀');
    const messages = chatHistory.getMessages();

    assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '主人好呀' },
    ]);
    assert.equal(messages[0].id, user.id);
    assert.equal(messages[1].id, assistant.id);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).messages.length, 2);
  } finally {
    chatHistory.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chat history rejects invalid messages and trims stored text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-chat-history-'));
  chatHistory.setRuntimePath(path.join(dir, 'chat-history.json'));

  try {
    assert.throws(() => chatHistory.appendMessage('system', 'no'));
    const message = chatHistory.appendMessage('user', '  hi  ');
    assert.equal(message.content, 'hi');
  } finally {
    chatHistory.setRuntimePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
