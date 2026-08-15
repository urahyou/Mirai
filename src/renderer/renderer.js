const $ = (selector) => document.querySelector(selector);

const balloon = $('#balloon');
const balloonText = $('#balloon-text');
const character = $('#character');
const LIVE2D_MODEL = '../../assets/live2d/models/hiyori_free_zh/runtime/hiyori_free_t08.model3.json';

const GREET_COOLDOWN_MS = 1200;
const TYPING_DELAY_MS = 240;
const BUBBLE_MIN_VISIBLE_MS = 4200;
const BUBBLE_POSITION_STORAGE_KEY = 'mirai.balloon-position.v1';

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
let pointerHit = false;
let mousePassthrough = false;
// 穿透迟滞：指针离开角色/气泡后要持续这么长时间才允许“点击穿透”，
// 避免边缘或模型运动瞬间的一帧误判立刻变成穿透到桌面。
const PASSTHROUGH_GRACE_MS = 200;
let lastHitAt = 0;
let lastPointer = null;
let pointerUpdateFrame = null;
let balloonDragging = false;
let balloonDragLast = null;
let balloonPosition = loadBalloonPosition();
let dragOffset = null;

function isCharacterHit(clientX, clientY) {
  return Boolean(live2dAvatar?.isHit(clientX, clientY));
}

function loadBalloonPosition() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(BUBBLE_POSITION_STORAGE_KEY));
    const x = Number(saved?.x);
    const y = Number(saved?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

function saveBalloonPosition() {
  if (!balloonPosition) return;
  window.localStorage.setItem(BUBBLE_POSITION_STORAGE_KEY, JSON.stringify(balloonPosition));
}

function applyBalloonPosition() {
  if (!balloonPosition || balloon.classList.contains('hidden')) return;
  const rect = balloon.getBoundingClientRect();
  const halfWidth = rect.width / 2;
  const maxTop = Math.max(0, window.innerHeight - rect.height - 9);
  const centerX = Math.max(halfWidth, Math.min(window.innerWidth - halfWidth, balloonPosition.x * window.innerWidth));
  const top = Math.max(0, Math.min(maxTop, balloonPosition.y * window.innerHeight));
  balloon.style.left = `${centerX}px`;
  balloon.style.top = `${top}px`;
}

function resetBalloonPosition() {
  balloon.style.left = '';
  balloon.style.top = '';
}

function isPointInside(element, clientX, clientY) {
  if (!element || element.classList.contains('hidden')) return false;
  const rect = element.getBoundingClientRect();
  return clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom;
}

function setMousePassthrough(passthrough) {
  if (mousePassthrough === passthrough) return;
  mousePassthrough = passthrough;
  window.desktopPet.setMousePassthrough(passthrough);
}

function updatePointerRegion() {
  pointerUpdateFrame = null;
  if (dragging) {
    character.dataset.pointerHit = 'true';
    setMousePassthrough(false);
    return;
  }
  if (!lastPointer) return;
  const { x, y } = lastPointer;
  const characterHit = isCharacterHit(x, y);
  const bubbleHit = isPointInside(balloon, x, y);
  const now = performance.now();
  if (characterHit || bubbleHit) lastHitAt = now;
  character.dataset.pointerHit = characterHit ? 'true' : 'false';
  // 迟滞：只有指针离开角色/气泡持续超过 grace 才转成可穿透。
  // 这样点中的瞬间或模型轻微晃动时，不会因一帧误判而把点击漏到背后的桌面。
  if (now - lastHitAt >= PASSTHROUGH_GRACE_MS && !characterHit && !bubbleHit) {
    setMousePassthrough(!characterHit && !bubbleHit);
  } else {
    setMousePassthrough(false);
  }
}

function schedulePointerRegionUpdate() {
  if (pointerUpdateFrame !== null) return;
  pointerUpdateFrame = requestAnimationFrame(updatePointerRegion);
}

function applyDisplaySettings(settings) {
  character.dataset.outlineShadow = settings?.outlineShadow ? 'true' : 'false';
}

function detectFace(text) {
  const value = String(text || '');
  if (['对不起', '抱歉', '难过', '伤心', '哭', '讨厌', '生气', '烦', '再见'].some((word) => value.includes(word))) return 'sad';
  if (['开心', '高兴', '喜欢', '谢谢', '太好了', '真好', '棒', '你好', '嗨', '辛苦', '爱'].some((word) => value.includes(word))) return 'happy';
  return 'idle';
}

function setFace(state) {
  const face = ['idle', 'happy', 'sad'].includes(state) ? state : 'idle';
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
    schedulePointerRegionUpdate();
  } catch (error) {
    console.error('[Live2D] Failed to load model.', error);
    live2dAvatar?.destroy();
    live2dAvatar = null;
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
  requestAnimationFrame(applyBalloonPosition);
  document.body.classList.add('speaking');
  schedulePointerRegionUpdate();
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
  requestAnimationFrame(applyBalloonPosition);
  document.body.classList.add('speaking');
  schedulePointerRegionUpdate();
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
  requestAnimationFrame(applyBalloonPosition);
  document.body.classList.add('speaking');
  schedulePointerRegionUpdate();
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
  balloonHideTimer = setTimeout(() => {
    balloon.classList.add('hidden');
    resetBalloonPosition();
    schedulePointerRegionUpdate();
  }, 300);
  schedulePointerRegionUpdate();
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

character.addEventListener('mousedown', (event) => {
  pointerHit = false;
  if (event.button !== 0) return;
  const hit = isCharacterHit(event.clientX, event.clientY);
  if (!hit) return;
  pointerHit = true;
  dragging = true;
  dragged = false;
  lastMouse = { x: event.clientX, y: event.clientY };
  // 记录抓取点相对窗口的偏移，拖拽全程用屏幕坐标做绝对定位
  dragOffset = { x: event.screenX - window.screenX, y: event.screenY - window.screenY };
});

window.addEventListener('mousemove', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY };
  // 悬停时同步更新手型光标/鼠标穿透：透明+穿透窗口上 rAF 常不触发，
  // 必须跟 mousedown 一样直接同步命中检测，否则光标要等点击才出现。
  updatePointerRegion();
  // 拖拽过程中暂停视线跟随：否则头部/眼球/身体会拼命追光标，造成抖动
  if (!dragging) live2dAvatar?.focus(event.clientX, event.clientY);
  if (balloonDragging && balloonDragLast) {
    const dx = event.clientX - balloonDragLast.x;
    const dy = event.clientY - balloonDragLast.y;
    if (dx || dy) {
      const rect = balloon.getBoundingClientRect();
      balloonPosition = {
        x: (rect.left + rect.width / 2 + dx) / window.innerWidth,
        y: (rect.top + dy) / window.innerHeight,
      };
      applyBalloonPosition();
      balloonDragLast = { x: event.clientX, y: event.clientY };
    }
    return;
  }
  if (!dragging || !lastMouse || !dragOffset) return;
  // 无实际位移的 mousemove（如按下时的微小抖动）不算拖拽，避免误触点击判定
  const dx = event.clientX - lastMouse.x;
  const dy = event.clientY - lastMouse.y;
  if (!dx && !dy) return;
  const targetX = event.screenX - dragOffset.x;
  const targetY = event.screenY - dragOffset.y;
  // 真正的拖拽（有位移）才降置顶层级：普通点击不触发，避免影响 click/dblclick/contextmenu
  if (!dragged) {
    dragged = true;
    window.desktopPet.setDragState(true);
  }
  // 绝对定位：窗口左上角 = 光标屏幕坐标 - 抓取偏移，完全锁定鼠标
  window.desktopPet.moveTo(targetX, targetY);
  lastMouse = { x: event.clientX, y: event.clientY };
});

window.addEventListener('mouseup', () => {
  if (balloonDragging) saveBalloonPosition();
  balloonDragging = false;
  balloonDragLast = null;
  dragging = false;
  lastMouse = null;
  dragOffset = null;
  if (dragged) window.desktopPet.setDragState(false);
  schedulePointerRegionUpdate();
});

balloon.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('#balloon-text')) return;
  balloonDragging = true;
  balloonDragLast = { x: event.clientX, y: event.clientY };
  event.preventDefault();
  event.stopPropagation();
});

window.addEventListener('resize', () => requestAnimationFrame(applyBalloonPosition));

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

character.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (isCharacterHit(event.clientX, event.clientY)) window.desktopPet.openMenu(event.screenX, event.screenY);
});

window.desktopPet.onChatDelta(handleChatDelta);
window.desktopPet.display.onChanged(applyDisplaySettings);

window.desktopPet.display.get().then(applyDisplaySettings).catch(() => {});

setMousePassthrough(true);
initLive2D();
