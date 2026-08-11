const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let runtimePath = null;

function readDocument() {
  if (!runtimePath) return { version: 1, messages: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) return { version: 1, messages: [] };
    return { version: 1, messages: parsed.messages.map(normalizeMessage).filter(Boolean) };
  } catch {
    return { version: 1, messages: [] };
  }
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!role || !content) return null;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    role,
    content: content.slice(0, 4000),
    createdAt,
  };
}

function writeDocument(document) {
  if (!runtimePath) throw new Error('chat history runtime path 未初始化');
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify(document, null, 2));
}

function getMessages() {
  return readDocument().messages;
}

function appendMessage(role, content) {
  const message = normalizeMessage({ id: crypto.randomUUID(), role, content, createdAt: Date.now() });
  if (!message) throw new TypeError('chat message 格式不正确');
  const document = readDocument();
  document.messages.push(message);
  writeDocument(document);
  return message;
}

function setRuntimePath(filePath) {
  runtimePath = filePath || null;
}

module.exports = {
  appendMessage,
  getMessages,
  setRuntimePath,
};
