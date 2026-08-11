const $ = (selector) => document.querySelector(selector);

const balloon = $('#balloon');
const balloonText = $('#balloon-text');
const character = $('#character');
const LIVE2D_MODEL = '../../assets/live2d/models/hiyori_free_zh/runtime/hiyori_free_t08.model3.json';
const FACES = {
  idle: '../../assets/character/idle.png',
  happy: '../../assets/character/happy.png',
  sad: '../../assets/character/sad.png',
};

const GREET_COOLDOWN_MS = 1200;
const TYPING_DELAY_MS = 240;
const BUBBLE_MIN_VISIBLE_MS = 4200;

let balloonTimer = null;
let balloonHideTimer = null;
let typingTimer = null;
let live2dAvatar = null;
let dragging = false;
let dragged = false;
let lastMouse = null;
let greetTimer = null;
let greetBusy = false;
let lastGreetAt = 0;
let bubbleToken = 0;
let activeChatTurnId = null;
let formalChatActive = false;
let characterHitCache = null;
let pointerHit = false;

async function buildCharacterHitCache() {
  const image = $('#character-img');
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
    await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
  }
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  characterHitCache = {
    width: canvas.width,
    height: canvas.height,
    alpha: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
  return characterHitCache;
}

async function isCharacterHit(clientX, clientY) {
  const cache = characterHitCache || await buildCharacterHitCache();
  if (!cache) return false;
  const rect = character.getBoundingClientRect();
  const scale = Math.min(rect.width / cache.width, rect.height / cache.height);
  const drawnWidth = cache.width * scale;
  const drawnHeight = cache.height * scale;
  const left = rect.left + (rect.width - drawnWidth) / 2;
  const top = rect.top + (rect.height - drawnHeight) / 2;
  const px = Math.floor((clientX - left) / scale);
  const py = Math.floor((clientY - top) / scale);
  if (px < 0 || py < 0 || px >= cache.width || py >= cache.height) return false;
  return cache.alpha[(py * cache.width + px) * 4 + 3] > 16;
}

function detectFace(text) {
  const value = String(text || '');
  if (['对不起', '抱歉', '难过', '伤心', '哭', '讨厌', '生气', '烦', '再见'].some((word) => value.includes(word))) return 'sad';
  if (['开心', '高兴', '喜欢', '谢谢', '太好了', '真好', '棒', '你好', '嗨', '辛苦', '爱'].some((word) => value.includes(word))) return 'happy';
  return 'idle';
}

function setFace(state) {
  const face = FACES[state] ? state : 'idle';
  $('#character-img').src = FACES[face];
  document.body.dataset.face = face;
  live2dAvatar?.setState(face);
}

async function initLive2D() {
  const canvas = $('#character-canvas');
  if (!canvas || !window.Live2DAvatar) return;
  try {
    live2dAvatar = new window.Live2DAvatar({
      canvas,
      modelSrc: new URL(LIVE2D_MODEL, window.location.href).href,
    });
    await live2dAvatar.load();
    character.dataset.live2dReady = 'true';
    setFace(document.body.dataset.face || 'idle');
  } catch (error) {
    console.error('[Live2D] Failed to load model; keeping PNG fallback.', error);
    live2dAvatar?.destroy();
    live2dAvatar = null;
    character.dataset.live2dFallback = 'true';
  }
}

function clearBubbleTimers() {
  clearTimeout(balloonTimer);
  clearTimeout(balloonHideTimer);
  clearTimeout(typingTimer);
  balloonTimer = null;
  balloonHideTimer = null;
  typingTimer = null;
}

function showBalloon(text, face = detectFace(text), visibleMs = null) {
  const value = String(text || '');
  clearBubbleTimers();
  balloonText.classList.remove('typing');
  balloonText.textContent = value;
  balloonText.scrollTop = balloonText.scrollHeight;
  setFace(face);
  balloon.classList.remove('hidden');
  balloon.classList.add('show');
  document.body.classList.add('speaking');
  const duration = visibleMs || Math.max(BUBBLE_MIN_VISIBLE_MS, Math.min(7600, 2600 + value.length * 42));
  balloonTimer = setTimeout(hideBalloon, duration);
}

function showTypingBalloon() {
  clearTimeout(balloonTimer);
  clearTimeout(balloonHideTimer);
  balloonTimer = null;
  balloonHideTimer = null;
  balloonText.textContent = '';
  balloonText.classList.add('typing');
  balloon.classList.remove('hidden');
  balloon.classList.add('show');
  document.body.classList.add('speaking');
}

function updateStreamBalloon(full) {
  clearTimeout(balloonTimer);
  clearTimeout(balloonHideTimer);
  clearTimeout(typingTimer);
  balloonText.classList.remove('typing');
  balloonText.textContent = String(full || '');
  balloonText.scrollTop = balloonText.scrollHeight;
  balloon.classList.remove('hidden');
  balloon.classList.add('show');
  document.body.classList.add('speaking');
}

function finishStreamBalloon(full) {
  const value = String(full || balloonText.textContent || '');
  balloonText.classList.remove('typing');
  balloonText.textContent = value;
  balloonText.scrollTop = balloonText.scrollHeight;
  setFace(detectFace(value));
  clearTimeout(balloonTimer);
  balloonTimer = setTimeout(hideBalloon, Math.max(BUBBLE_MIN_VISIBLE_MS, Math.min(7600, 2600 + value.length * 42)));
}

function hideBalloon() {
  clearBubbleTimers();
  balloon.classList.remove('show');
  document.body.classList.remove('speaking');
  balloonHideTimer = setTimeout(() => balloon.classList.add('hidden'), 300);
}

function beginFormalChat(turnId) {
  formalChatActive = true;
  activeChatTurnId = turnId;
  bubbleToken += 1;
  clearTimeout(greetTimer);
  typingTimer = setTimeout(() => {
    if (formalChatActive && activeChatTurnId === turnId) showTypingBalloon();
  }, TYPING_DELAY_MS);
}

function handleChatDelta(data) {
  if (!data || !data.turnId) return;
  if (data.started) {
    beginFormalChat(data.turnId);
    return;
  }
  if (activeChatTurnId !== data.turnId) return;
  if (!data.done) {
    updateStreamBalloon(data.full);
    return;
  }
  formalChatActive = false;
  finishStreamBalloon(data.full);
  activeChatTurnId = null;
}

character.addEventListener('mousedown', async (event) => {
  pointerHit = false;
  if (event.button !== 0) return;
  const hit = await isCharacterHit(event.clientX, event.clientY);
  if (!hit) return;
  pointerHit = true;
  dragging = true;
  dragged = false;
  lastMouse = { x: event.clientX, y: event.clientY };
});

window.addEventListener('mousemove', (event) => {
  live2dAvatar?.focus(event.clientX, event.clientY);
  if (!dragging || !lastMouse) return;
  const dx = event.clientX - lastMouse.x;
  const dy = event.clientY - lastMouse.y;
  if (!dx && !dy) return;
  dragged = true;
  window.desktopPet.moveBy(dx, dy);
  lastMouse = { x: event.clientX, y: event.clientY };
});

window.addEventListener('mouseup', () => {
  dragging = false;
  lastMouse = null;
});

character.addEventListener('click', (event) => {
  if (!pointerHit || dragged || formalChatActive || greetBusy || Date.now() - lastGreetAt < GREET_COOLDOWN_MS) return;
  clearTimeout(greetTimer);
  const { clientX, clientY } = event;
  greetTimer = setTimeout(async () => {
    if (formalChatActive || greetBusy) return;
    greetBusy = true;
    lastGreetAt = Date.now();
    const requestToken = ++bubbleToken;
    live2dAvatar?.tap(clientX, clientY);
    try {
      const reply = await window.desktopPet.greet();
      if (reply && requestToken === bubbleToken && !formalChatActive) showBalloon(reply, 'happy');
    } finally {
      greetBusy = false;
    }
  }, 260);
});

character.addEventListener('dblclick', () => {
  clearTimeout(greetTimer);
  if (pointerHit && !dragged) window.desktopPet.openChatInput();
});

character.addEventListener('contextmenu', async (event) => {
  event.preventDefault();
  if (await isCharacterHit(event.clientX, event.clientY)) window.desktopPet.openMenu(event.screenX, event.screenY);
});

window.desktopPet.onChatDelta(handleChatDelta);

buildCharacterHitCache().catch(() => {});
initLive2D();
