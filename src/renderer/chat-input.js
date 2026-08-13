const $ = (selector) => document.querySelector(selector);
const chatbox = $('#chatbox');
const input = $('#chat-input');
const sendButton = $('#send-button');
const expandButton = $('#expand-button');
const closeButton = $('#close-button');
const historyList = $('#history-list');

let composing = false;
let submitting = false;
let expanded = false;
let autoHideTimer = null;
let dragging = false;
let last = null;
let streamingMessage = null;
let streamingTurnId = null;
const messageIds = new Set();

const AUTO_HIDE_MS = 8000;
const MAX_INPUT_HEIGHT = 100;

function clearAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
}

function scheduleAutoHide() {
  clearAutoHide();
  if (expanded || submitting || input.value.trim()) return;
  autoHideTimer = setTimeout(() => window.desktopPet.closeChatInput(), AUTO_HIDE_MS);
}

function markActivity() {
  if (expanded || input.value.trim()) clearAutoHide();
  else scheduleAutoHide();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`;
}

function resizeInputWindow() {
  if (expanded) return;
  const inputHeight = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT);
  const targetHeight = Math.max(96, Math.min(180, 22 + 16 + inputHeight + 4));
  window.desktopPet.resizeChatInput(targetHeight);
}

function wasNearBottom() {
  return historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight < 36;
}

function scrollToLatest(force = false) {
  if (force || wasNearBottom()) historyList.scrollTop = historyList.scrollHeight;
}

function renderMessage(message, options = {}) {
  if (!message || !message.content || (!options.streaming && messageIds.has(message.id))) return null;
  const row = document.createElement('article');
  row.className = `message ${message.role}${options.streaming ? ' streaming' : ''}`;
  if (message.id) row.dataset.messageId = message.id;
  if (options.turnId) row.dataset.turnId = options.turnId;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = message.role === 'user' ? '主' : '未';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.content;
  row.append(avatar, bubble);
  historyList.append(row);
  if (message.id) messageIds.add(message.id);
  return row;
}

function removeStreamingMessage(turnId) {
  if (!streamingMessage || (turnId && streamingTurnId !== turnId)) return;
  streamingMessage.remove();
  streamingMessage = null;
  streamingTurnId = null;
}

function addDurableMessage(message, turnId) {
  const atBottom = wasNearBottom();
  if (message.role === 'assistant' && streamingMessage && streamingTurnId === turnId) {
    removeStreamingMessage(turnId);
  }
  renderMessage(message);
  scrollToLatest(atBottom);
}

function updateStreamingMessage(data) {
  if (!data || !data.turnId || !data.full) return;
  const atBottom = wasNearBottom();
  if (data.done && (!streamingMessage || streamingTurnId !== data.turnId)) return;
  if (!streamingMessage || streamingTurnId !== data.turnId) {
    removeStreamingMessage();
    streamingTurnId = data.turnId;
    streamingMessage = renderMessage({ role: 'assistant', content: data.full }, { streaming: !data.done, turnId: data.turnId });
  } else {
    streamingMessage.classList.toggle('streaming', !data.done);
    streamingMessage.querySelector('.bubble').textContent = data.full;
  }
  scrollToLatest(atBottom);
}

async function setExpanded(next) {
  expanded = next;
  chatbox.classList.toggle('expanded', expanded);
  expandButton.textContent = expanded ? '−' : '⤢';
  expandButton.title = expanded ? '收起聊天记录' : '展开对话';
  expandButton.setAttribute('aria-label', expandButton.title);
  if (expanded) {
    clearAutoHide();
    await window.desktopPet.setChatExpanded(true);
    requestAnimationFrame(() => scrollToLatest(true));
  } else {
    await window.desktopPet.setChatExpanded(false);
    autosize();
    resizeInputWindow();
    scheduleAutoHide();
  }
}

async function submit() {
  if (submitting) return;
  const value = input.value.trim();
  if (!value) return;

  submitting = true;
  clearAutoHide();
  sendButton.disabled = true;
  sendButton.textContent = '…';
  input.value = '';
  autosize();

  try {
    await window.desktopPet.chatSubmit(value.slice(0, 4000));
    input.focus();
    scheduleAutoHide();
  } catch {
    input.value = value;
    autosize();
    resizeInputWindow();
    input.focus();
  } finally {
    submitting = false;
    sendButton.disabled = false;
    sendButton.textContent = '发送';
  }
}

input.addEventListener('input', () => {
  autosize();
  resizeInputWindow();
  markActivity();
});
input.addEventListener('compositionstart', () => {
  composing = true;
  clearAutoHide();
});
input.addEventListener('compositionend', () => {
  setTimeout(() => { composing = false; }, 0);
  markActivity();
});
input.addEventListener('keydown', (event) => {
  markActivity();
  if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Escape') {
    if (expanded) setExpanded(false);
    else window.desktopPet.closeChatInput();
  }
});
input.addEventListener('click', markActivity);
sendButton.addEventListener('click', () => { clearAutoHide(); submit(); });
expandButton.addEventListener('mousedown', (event) => event.stopPropagation());
expandButton.addEventListener('click', () => setExpanded(!expanded));
closeButton.addEventListener('mousedown', (event) => event.stopPropagation());
closeButton.addEventListener('click', () => window.desktopPet.closeChatInput());

const zone = $('#drag-zone');
zone.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  clearAutoHide();
  dragging = true;
  last = { x: event.screenX, y: event.screenY };
  event.preventDefault();
});
window.addEventListener('mousemove', (event) => {
  if (!dragging || !last) return;
  const dx = event.screenX - last.x;
  const dy = event.screenY - last.y;
  if (dx || dy) {
    window.desktopPet.moveBy(dx, dy);
    last = { x: event.screenX, y: event.screenY };
  }
});
window.addEventListener('mouseup', () => {
  dragging = false;
  last = null;
  markActivity();
});

window.desktopPet.onChatHistory(({ message, turnId }) => addDurableMessage(message, turnId));
window.desktopPet.onChatDelta((data) => updateStreamingMessage(data));

(async () => {
  try {
    const messages = await window.desktopPet.getChatHistory();
    messages.forEach((message) => renderMessage(message));
    scrollToLatest(true);
  } catch {
    // 历史记录不可用不影响即时聊天。
  }
})();

input.focus();
autosize();
resizeInputWindow();
scheduleAutoHide();
