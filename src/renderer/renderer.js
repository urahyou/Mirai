const $ = (sel) => document.querySelector(sel);

const balloon = $('#balloon');
const balloonText = $('#balloon-text');
const character = $('#character');

let balloonTimer = null;
let idleTimer = null;

// ---------- 角色表情状态 ----------

// 状态图片路径
const FACES = {
  idle: '../../assets/character/idle.png',
  happy: '../../assets/character/happy.png',
  sad: '../../assets/character/sad.png',
};

// 根据文本/场景判断情绪状态
function detectFace(text) {
  if (!text) return 'idle';
  const t = String(text);
  // 难过关键词：负面、责骂、道歉
  const sadWords = ['对不起', '抱歉', '难过', '伤心', '哭', '讨厌', '生气', '烦', '不好', '错了', '不要', '离开', '再见', '拜拜'];
  const happyWords = ['开心', '高兴', '喜欢', '谢谢', '太好了', '真好', '棒', '棒棒', '厉害', '欢迎', '你好', '嗨', '耶', '嘿嘿', '诶嘿', '辛苦', '夸', '爱'];
  if (sadWords.some((w) => t.includes(w))) return 'sad';
  if (happyWords.some((w) => t.includes(w))) return 'happy';
  return 'idle';
}

function setFace(state) {
  const img = $('#character-img');
  img.src = FACES[state] || FACES.idle;
  document.body.dataset.face = state || 'idle';
}

// ---------- 情绪 → 表现映射 ----------

let moodMap = null;
const MOOD_CLASSES = ['mood-calm', 'mood-happy', 'mood-excited', 'mood-sad', 'mood-bored', 'mood-tired', 'mood-overwhelmed'];

function moodEntry(mood) {
  return (moodMap && moodMap[mood]) || (moodMap && moodMap.calm);
}

// 情绪同时通过 class + 文字状态表达；动画只是增强，不是唯一通道（无障碍要求）。
function applyMood(mood) {
  const entry = moodEntry(mood);
  if (!entry) return;
  document.body.classList.remove(...MOOD_CLASSES);
  if (entry.moodClass) document.body.classList.add(entry.moodClass);
  if (entry.animation) {
    document.body.dataset.moodAnim = entry.animation;
  } else {
    delete document.body.dataset.moodAnim;
  }
  document.body.dataset.mood = mood || 'calm';
  setFace(entry.face);
}

function applySettings(settings) {
  const s = settings || {};
  document.body.classList.toggle('reduce-motion', s.reduceMotion === true);
  document.body.classList.toggle('no-animation', s.animation !== true);
  document.body.classList.toggle('no-sound', s.sound !== true);
}

// ---------- 像素级命中检测（只在人物非透明像素内响应） ----------

const hitCanvas = document.createElement('canvas');
const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });
const hitCache = new Map(); // path -> ImageData alpha map

async function buildHitCache(src) {
  if (hitCache.has(src)) return hitCache.get(src);
  const img = new Image();
  img.src = src;
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
  });
  // 使用与原图 1:1 的分辨率建立 alpha 表，命中检测按比例缩放
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  hitCanvas.width = iw;
  hitCanvas.height = ih;
  hitCtx.clearRect(0, 0, iw, ih);
  hitCtx.drawImage(img, 0, 0, iw, ih);
  const data = hitCtx.getImageData(0, 0, iw, ih).data;
  hitCache.set(src, { width: iw, height: ih, data });
  return hitCache.get(src);
}

/**
 * 判断窗口坐标 (clientX, clientY) 是否落在人物非透明像素上。
 * 通过 CSS 变换把窗口坐标映射回角色图片的像素坐标。
 */
async function isCharacterHit(clientX, clientY) {
  const img = $('#character-img');
  const src = img.src;
  try {
    const map = await buildHitCache(src);
    const rect = img.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    // 图片在 rect 内（含 transform 缩放），映射到原图像素坐标
    const px = Math.floor(((clientX - rect.left) / rect.width) * map.width);
    const py = Math.floor(((clientY - rect.top) / rect.height) * map.height);
    if (px < 0 || py < 0 || px >= map.width || py >= map.height) return false;
    const alpha = map.data[(py * map.width + px) * 4 + 3];
    // 全透明视为未命中
    return alpha > 8;
  } catch {
    return false;
  }
}

// ---------- 拖拽移动 ----------

let dragging = false;
let lastMouse = null;
let dragged = false;
let pressOnCharacter = false;

character.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  pressOnCharacter = await isCharacterHit(e.clientX, e.clientY);
  if (!pressOnCharacter) return;
  dragging = true;
  dragged = false;
  lastMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !lastMouse) return;
  const dx = e.clientX - lastMouse.x;
  const dy = e.clientY - lastMouse.y;
  if (dx !== 0 || dy !== 0) {
    dragged = true;
    window.desktopPet.moveBy(dx, dy);
    lastMouse = { x: e.clientX, y: e.clientY };
  }
});

window.addEventListener('mouseup', () => {
  dragging = false;
  lastMouse = null;
});

// ---------- 气泡 ----------

function showBalloon(text, face) {
  const safeText = text == null ? '' : String(text);
  clearTimeout(balloonTimer);
  balloonText.textContent = safeText;
  if (face) setFace(face);
  balloon.classList.remove('hidden');
  balloon.classList.add('show');
  document.body.classList.add('speaking');

  // 关闭前保持一小段时间
  clearTimeout(balloonTimer);
  balloonTimer = setTimeout(() => {
    balloon.classList.remove('show');
    document.body.classList.remove('speaking');
    setTimeout(() => balloon.classList.add('hidden'), 300);
  }, 4000 + Math.min(safeText.length * 40, 3000));
}

// 流式气泡：先显示空气泡，随增量块不断追加文本，并保持滚动到底部
function streamBalloonStart() {
  clearTimeout(balloonTimer);
  balloon.classList.remove('hidden');
  balloon.classList.add('show');
  document.body.classList.add('speaking');
}

function streamBalloonAppend(full) {
  balloonText.textContent = full == null ? '' : String(full);
  // 始终滚动到底部，让最新的说话内容可见
  balloonText.scrollTop = balloonText.scrollHeight;
}

function streamBalloonEnd() {
  clearTimeout(balloonTimer);
  balloonTimer = setTimeout(() => {
    balloon.classList.remove('show');
    document.body.classList.remove('speaking');
    setTimeout(() => balloon.classList.add('hidden'), 300);
  }, 4000 + Math.min(balloonText.textContent.length * 40, 3000));
}

function hideBalloon() {
  clearTimeout(balloonTimer);
  balloon.classList.remove('show');
  document.body.classList.remove('speaking');
  setTimeout(() => balloon.classList.add('hidden'), 300);
}

// ---------- 交互 ----------

// 单击：打招呼
character.addEventListener('click', async () => {
  if (dragged) return;
  const reply = await window.desktopPet.greet();
  if (reply) showBalloon(reply, 'happy');
  resetIdle();
});

// 双击：进入对话（打开独立可全屏拖拽的输入窗口）
character.addEventListener('dblclick', (e) => {
  if (dragged) return;
  window.desktopPet.openChatInput();
});

// 右键：打开独立菜单窗口
character.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.desktopPet.openMenu(e.screenX, e.screenY);
});

// ---------- 情感状态面板 ----------

const statePanel = $('#state-panel');
const stateMemoryEl = $('#state-memory');
if (stateMemoryEl) {
  stateMemoryEl.addEventListener('click', () => {
    if (window.desktopPet.openMemoryPanel) window.desktopPet.openMemoryPanel();
  });
}
let statePanelDrag = null;

function renderStatePanel(state) {
  if (!state) return;
  const entry = moodEntry(state.mood);
  applyMood(state.mood);
  const moodNames = {
    calm: '平静',
    happy: '开心',
    excited: '兴奋',
    sad: '低落',
    bored: '有点无聊',
    tired: '有点累',
    overwhelmed: '压力有点大',
  };
  $('#state-mood').textContent = moodNames[state.mood] || state.mood || '平静';
  $('#state-mood-score').textContent = `心情 ${state.moodScore}`;
  const reasonEl = $('#state-reason');
  if (reasonEl) reasonEl.textContent = entry ? entry.reason : '';
  const memEl = $('#state-memory');
  if (memEl) {
    const c = state.memoryCounts;
    if (c) {
      let t = `记忆 · 常驻 ${c.core} · 档案 ${c.working}`;
      if (c.summaries) t += ` · 摘要 ${c.summaries}`;
      memEl.textContent = t;
      memEl.style.display = 'block';
    } else {
      memEl.style.display = 'none';
    }
  }
  for (const key of ['affection', 'energy', 'health', 'stress', 'loneliness']) {
    const value = Math.max(0, Math.min(100, Number(state[key]) || 0));
    $(`#state-${key}`).textContent = String(value);
    $(`#state-${key}-bar`).style.width = `${value}%`;
  }
}

async function openStatePanel() {
  const state = await window.desktopPet.getState();
  renderStatePanel(state);
  statePanel.classList.remove('hidden');
  if (!statePanel.style.left) {
    statePanel.style.left = '8px';
    statePanel.style.top = '8px';
  }
}

function closeStatePanel() {
  statePanel.classList.add('hidden');
}

$('#state-panel-close').addEventListener('click', (e) => {
  e.stopPropagation();
  closeStatePanel();
});

$('#state-panel-header').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  statePanelDrag = {
    startX: e.clientX,
    startY: e.clientY,
    left: parseFloat(statePanel.style.left) || 0,
    top: parseFloat(statePanel.style.top) || 0,
  };
  e.preventDefault();
  e.stopPropagation();
});

window.addEventListener('mousemove', (e) => {
  if (!statePanelDrag) return;
  const left = statePanelDrag.left + e.clientX - statePanelDrag.startX;
  const top = statePanelDrag.top + e.clientY - statePanelDrag.startY;
  statePanel.style.left = `${Math.max(4, Math.min(left, window.innerWidth - statePanel.offsetWidth - 4))}px`;
  statePanel.style.top = `${Math.max(4, Math.min(top, window.innerHeight - statePanel.offsetHeight - 4))}px`;
});

window.addEventListener('mouseup', () => {
  statePanelDrag = null;
});

// ---------- 对话输入 ----------
// 输入框已改为独立可全屏拖拽的窗口（chat-input.html），
// 由双击角色触发 window.desktopPet.openChatInput() 打开。
// 提交后主进程通过 chat:delta 事件推送流式回复，由 onChatDelta 驱动气泡显示。

// ---------- 空闲随机闲聊 ----------

function resetIdle() {
  clearTimeout(idleTimer);
  scheduleIdle();
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  const delay = 20000 + Math.random() * 40000; // 20~60 秒
  idleTimer = setTimeout(async () => {
    await window.desktopPet.requestProactiveDecision();
    scheduleIdle();
  }, delay);
}

// ---------- 启动 ----------

async function init() {
  moodMap = await window.desktopPet.getMoodMap();
  applySettings(await window.desktopPet.settings.get());
  renderStatePanel(await window.desktopPet.getState());
  window.desktopPet.onStateChanged(renderStatePanel);
  window.desktopPet.onProactiveDecision((decision) => {
    if (decision.shouldPrompt) showBalloon(decision.content, 'idle');
  });
  window.desktopPet.onChatDelta((d) => {
    if (d.done) {
      // 规则回复和兜底回复没有增量块，完成事件可能是第一条事件。
      if (!balloon.classList.contains('show')) streamBalloonStart();
      streamBalloonAppend(d.full);
      setFace(detectFace(d.full) || 'idle');
      streamBalloonEnd();
      resetIdle();
    } else {
      if (!balloon.classList.contains('show')) streamBalloonStart();
      streamBalloonAppend(d.full);
    }
  });
  window.desktopPet.onToast((toast) => {
    if (toast && toast.text) {
      showBalloon(toast.text, toast.face || 'happy');
      resetIdle();
    }
  });
  window.desktopPet.onShowState(() => openStatePanel());
  window.desktopPet.onReminder((reminder) => {
    if (reminder) {
      showBalloon(`提醒：${reminder.title}${reminder.note ? `\n${reminder.note}` : ''}`, 'happy');
      resetIdle();
    }
  });
  // 开场白
  setTimeout(() => {
    interview();
  }, 600);
}

// 开场白：大模型生成问候；llm 不可用时安静等待
async function interview() {
  const { line } = await window.desktopPet.greeting().catch(() => ({ line: '' }));
  if (line) showBalloon(line, 'happy');
  setTimeout(() => hideBalloon(), 4500);
  resetIdle();
}

init();
