const $ = (sel) => document.querySelector(sel);
const input = $('#chat-input');
const sendButton = $('#send-button');

let composing = false;
let submitting = false;
let autoHideTimer = null;
let dragging = false;
let last = null;

const AUTO_HIDE_MS = 8000;
const MAX_INPUT_HEIGHT = 140;

function clearAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
}

function scheduleAutoHide() {
  clearAutoHide();
  // 有内容时不自动关闭，避免用户思考或编辑长文本时丢失输入框。
  if (submitting || input.value.trim()) return;
  autoHideTimer = setTimeout(() => {
    window.desktopPet.closeChatInput();
  }, AUTO_HIDE_MS);
}

function markActivity() {
  if (input.value.trim()) clearAutoHide();
  else scheduleAutoHide();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
}

function resizeInputWindow() {
  const inputHeight = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT);
  const targetHeight = Math.max(96, Math.min(220, 22 + 16 + inputHeight + 4));
  window.desktopPet.resizeChatInput(targetHeight);
}

async function submit() {
  if (submitting) return;
  const val = input.value.trim();
  if (!val) return;

  submitting = true;
  clearAutoHide();
  input.disabled = true;
  sendButton.disabled = true;
  sendButton.textContent = '…';
  input.value = '';
  autosize();

  try {
    await window.desktopPet.chatSubmit(val.slice(0, 4000));
    // 回复结束后保留输入框，方便用户继续追问；空闲时再由自动隐藏逻辑关闭。
    input.disabled = false;
    sendButton.disabled = false;
    sendButton.textContent = '发送';
    input.focus();
    scheduleAutoHide();
  } catch {
    // 如果 IPC 失败，恢复输入内容，避免用户丢失文字。
    input.disabled = false;
    sendButton.disabled = false;
    sendButton.textContent = '发送';
    input.value = val;
    autosize();
    resizeInputWindow();
    input.focus();
  } finally {
    submitting = false;
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
  // 部分中文输入法会在 compositionend 后紧接着派发 keydown。
  setTimeout(() => { composing = false; }, 0);
  markActivity();
});

input.addEventListener('keydown', (e) => {
  markActivity();
  if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    window.desktopPet.closeChatInput();
  }
});

input.addEventListener('click', markActivity);
sendButton.addEventListener('click', () => {
  clearAutoHide();
  submit();
});

// 顶部拖动栏只负责移动窗口，不会覆盖文本输入区域。
const zone = $('#drag-zone');
zone.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  clearAutoHide();
  dragging = true;
  last = { x: e.screenX, y: e.screenY };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !last) return;
  const dx = e.screenX - last.x;
  const dy = e.screenY - last.y;
  if (dx !== 0 || dy !== 0) {
    window.desktopPet.moveBy(dx, dy);
    last = { x: e.screenX, y: e.screenY };
  }
});

window.addEventListener('mouseup', () => {
  dragging = false;
  last = null;
  markActivity();
});

input.focus();
autosize();
resizeInputWindow();
scheduleAutoHide();
