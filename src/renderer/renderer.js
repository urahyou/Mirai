/**
 * 宠物窗（主窗口）渲染进程：Live2D 角色 + 气泡/拖拽/点击交互 + 语音播放。
 * 与主进程通过 preload 暴露的 `window.desktopPet.*` 通信（不直接 require）。
 *
 * 职责分区（按文件内顺序）：
 *   1. 常量与 DOM 引用
 *   2. Live2D 角色初始化与命中检测（常用 Live2DAvatar.isHit）
 *   3. 拖拽（window:moveBy / setDragState）与点击回应（character:greet）
 *   4. 气泡：接收 balloon.render / show / hide，匹配类型与消失时长
 *   5. 聊天流式回复：chat:delta 增量展示
 *   6. 语音播放：voice:audio 解码 + voice:speak-interrupt 打断
 *   7. 显示设置 / 鼠标穿透 / 菜单 / 各种面板打开
 */

const $ = (selector) => document.querySelector(selector);

const balloon = $('#balloon'); // 占位命中目标（气泡实际渲染在独立窗口 balloonWindow）
const character = $('#character');
const LIVE2D_MODEL = '../../assets/live2d/models/hiyori_free_zh/runtime/hiyori_free_t08.model3.json';

const GREET_COOLDOWN_MS = 1200;
const TYPING_DELAY_MS = 240;
const BUBBLE_MIN_VISIBLE_MS = 4200;

let typingTimer = null;
let balloonTimer = null;
let balloonHideTimer = null;
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
let dragOffset = null;
let bubbleDurationSec = 0; // 0=按文字长度自动；>0=固定秒数（设置面板可调）

function isCharacterHit(clientX, clientY) {
  return Boolean(live2dAvatar?.isHit(clientX, clientY));
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
  // 语音面板展开期间整个窗口保持可交互（面板内是开关，必须能点到）
  if (voiceDockOpen) {
    setMousePassthrough(false);
    return;
  }
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
  bubbleDurationSec = Number(settings?.bubbleDuration) || 0;
}

function bubbleHideDelay(value) {
  if (bubbleDurationSec > 0) return bubbleDurationSec * 1000;
  const length = String(value || '').length;
  return Math.max(BUBBLE_MIN_VISIBLE_MS, Math.min(7600, 2600 + length * 42));
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
  setFace(face);
  document.body.classList.add('speaking');
  window.desktopPet.balloon.show({ typing: false, text: value, face });
  const duration = visibleMs || bubbleHideDelay(value);
  balloonTimer = setTimeout(() => window.desktopPet.balloon.hide(), duration);
}

function showTypingBalloon() {
  clearTimeout(balloonTimer);
  clearTimeout(balloonHideTimer);
  balloonTimer = null;
  balloonHideTimer = null;
  document.body.classList.add('speaking');
  window.desktopPet.balloon.show({ typing: true, text: '' });
}

function updateStreamBalloon(full) {
  clearTimeout(balloonTimer);
  clearTimeout(balloonHideTimer);
  clearTimeout(typingTimer);
  document.body.classList.add('speaking');
  window.desktopPet.balloon.update(String(full || ''));
}

function finishStreamBalloon(full) {
  const value = String(full || '');
  setFace(detectFace(value));
  document.body.classList.add('speaking');
  window.desktopPet.balloon.finish({ text: value, face: detectFace(value) });
  clearTimeout(balloonTimer);
  balloonTimer = setTimeout(() => window.desktopPet.balloon.hide(), bubbleHideDelay(value));
}

function hideBalloon() {
  clearBubbleTimers();
  document.body.classList.remove('speaking');
  window.desktopPet.balloon.hide();
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
  dragging = false;
  lastMouse = null;
  dragOffset = null;
  if (dragged) window.desktopPet.setDragState(false);
  schedulePointerRegionUpdate();
});

character.addEventListener('click', (event) => {
  if (!pointerHit || dragged || formalChatActive) return;
  // 单击角色：切换语音控制扇形面板（半透明，内含 🎤/🔊 图标）
  setVoiceDockOpen(!voiceDockOpen);
  if (greetBusy || Date.now() - lastGreetAt < GREET_COOLDOWN_MS) return;
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

// ---------------- 语音输入（侧车） ----------------
let voiceStream = null;
let voiceContext = null;
let voiceProcessor = null;
let voiceListening = false;
let voiceSidecarReady = false; // 侧车模型是否已就绪（就绪前识别不可用）

async function ensureVoiceCapture() {
  const voice = window.desktopPet?.voice;
  if (!voice || voiceStream) return true;
  voice.start();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    voiceStream = stream;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    voiceContext = new Ctx({ sampleRate: 16000 });
    await voiceContext.resume();
    const source = voiceContext.createMediaStreamSource(stream);
    const proc = voiceContext.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!voiceListening) return; // 只有聆听开启时才送 PCM 给侧车
      const ch = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i] * 32768;
        i16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
      }
      voice.sendPcm(i16.buffer);
    };
    // 0 增益挂到 destination，让 ScriptProcessor 触发但不出声
    const silent = voiceContext.createGain();
    silent.gain.value = 0;
    source.connect(proc);
    proc.connect(silent);
    silent.connect(voiceContext.destination);
    voiceProcessor = proc;
    console.log('[Voice] 麦克风采集已就绪, ctx.sampleRate=', voiceContext.sampleRate);
    return true;
  } catch (err) {
    console.error('[Voice] 麦克风启动失败:', err);
    return false;
  }
}

// ---------- 语音控制扇形面板（单击角色弹出，左/右视空位） ----------
let voiceTtsEnabled = true; // 语音输出开关（读 .env SIDECAR_TTS_ENABLED）
let voiceDockOpen = false;

function updateVoiceDockIcons() {
  const input = document.getElementById('dock-voice-input');
  const output = document.getElementById('dock-voice-output');
  if (input) {
    const on = voiceListening;
    if (input.checked !== on) input.checked = on;
    input.closest('.dock-switch').classList.toggle('dock-loading', voiceListening && !voiceSidecarReady);
    input.title = !voiceListening
      ? '语音输入：开启'
      : voiceSidecarReady
        ? '聆听中，说话吧（再点关闭）'
        : '语音引擎加载中…（就绪后即可说话）';
    input.setAttribute('aria-label', input.title);
  }
  if (output) {
    if (output.checked !== voiceTtsEnabled) output.checked = voiceTtsEnabled;
    output.title = voiceTtsEnabled ? '语音输出：已开启（点击关闭朗读）' : '语音输出：已关闭（点击开启朗读）';
    output.setAttribute('aria-label', output.title);
  }
}

async function applyVoiceListening(on) {
  on = Boolean(on);
  voiceListening = on;
  if (on) {
    const ok = await ensureVoiceCapture();
    if (ok) await voiceContext?.resume();
  } else {
    await voiceContext?.suspend(); // 停止采集，保留授权避免重复弹窗
  }
  updateVoiceDockIcons();
}

// 在窗口内决定扇形面板放角色左边还是右边：看角色投影中心距离左右边缘哪边更宽
function positionVoiceDock() {
  const dock = document.getElementById('voice-dock');
  if (!dock) return;
  const rect = character.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const spaceLeft = cx;
  const spaceRight = window.innerWidth - cx;
  const placeRight = spaceRight >= spaceLeft; // 右边更宽就放右
  dock.classList.toggle('right', placeRight);
  dock.style.left = placeRight ? '' : '10px';
  dock.style.right = placeRight ? '10px' : '';
}

function setVoiceDockOpen(open) {
  const dock = document.getElementById('voice-dock');
  if (!dock) return;
  voiceDockOpen = Boolean(open);
  dock.classList.toggle('hidden', !voiceDockOpen);
  if (voiceDockOpen) {
    positionVoiceDock();
    // 面板展开：整个窗口保持可交互（面板内是开关，必须能点到）
    setMousePassthrough(false);
  } else {
    // 面板收起：恢复可穿透（角色/气泡 hover 由后续 mousemove 动态修正）
    schedulePointerRegionUpdate();
  }
}

// 聆听开关状态（主进程单一事实源，跨窗同步）
window.desktopPet.voice.onListening(applyVoiceListening);
// 宠物窗扇形面板里的 🎤 语音输入开关
const dockInputBtn = document.getElementById('dock-voice-input');
if (dockInputBtn) {
  dockInputBtn.addEventListener('change', (event) => {
    event.stopPropagation();
    window.desktopPet.voice.setListening(dockInputBtn.checked);
  });
}
// 宠物窗扇形面板里的 🔊 语音输出开关
const dockOutputBtn = document.getElementById('dock-voice-output');
if (dockOutputBtn) {
  dockOutputBtn.addEventListener('change', () => {
    const next = dockOutputBtn.checked;
    window.desktopPet.voice.setTtsEnabled(next);
    voiceTtsEnabled = next;
    updateVoiceDockIcons();
  });
}
// 点面板外空白处关闭面板（角色区域除外，交给角色 click 切换）
window.addEventListener('pointerdown', (event) => {
  if (!voiceDockOpen) return;
  const dock = document.getElementById('voice-dock');
  if (!dock || dock.contains(event.target)) return;
  if (isCharacterHit(event.clientX, event.clientY)) return;
  setVoiceDockOpen(false);
});
// 初始同步：若已开启（例如对话窗开过），宠物窗跟着开；同时记录侧车就绪度与语音输出状态
window.desktopPet.voice.getStatus().then((s) => {
  voiceSidecarReady = Boolean(s?.connected);
  if (typeof s?.ttsEnabled === 'boolean') voiceTtsEnabled = s.ttsEnabled;
  if (s?.listening) applyVoiceListening(true);
  updateVoiceDockIcons();
}).catch(() => updateVoiceDockIcons());
// 侧车就绪/重启 → 更新 🎤 加载中/就绪状态与 🔊 状态
window.desktopPet.voice.onStatus((s) => {
  voiceSidecarReady = Boolean(s?.connected);
  if (typeof s?.ttsEnabled === 'boolean') voiceTtsEnabled = s.ttsEnabled;
  updateVoiceDockIcons();
});

// ---------------- 语音输出（让小未来开口） ----------------
let ttsContext = null;
let ttsSource = null;
let ttsToken = 0; // 递增令牌：并发到达的音频只保留最新一句，从根上避免语音重叠

function ensureTtsContext() {
  if (ttsContext) return Promise.resolve(ttsContext);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  ttsContext = new Ctx();
  return ttsContext.resume().then(() => ttsContext);
}

function stopSpeech() {
  if (ttsSource) {
    try { ttsSource.stop(); } catch {/* already stopped */}
    ttsSource = null;
  }
  document.body.classList.remove('speaking');
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data && typeof data === 'object' && Array.isArray(data.data)) return new Uint8Array(data.data).buffer;
  return null;
}

async function playSpeech(audio) {
  const ab = toArrayBuffer(audio?.data);
  if (!ab || !ab.byteLength) return;
  const token = ++ttsToken; // 抢占最新令牌
  stopSpeech(); // 打断当前正在播放的语音
  try {
    const ctx = await ensureTtsContext();
    const buf = await ctx.decodeAudioData(ab);
    // decode 期间又有更新的音频到达 → 丢弃本句，只保留最新
    if (token !== ttsToken) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (ttsToken === token) {
        ttsSource = null;
        document.body.classList.remove('speaking');
      }
    };
    ttsSource = src;
    src.start();
    document.body.classList.add('speaking'); // 说话浮动动画
  } catch (err) {
    console.error('[Voice] 播放语音失败:', err);
    document.body.classList.remove('speaking');
  }
}

window.desktopPet.voice.onAudio(playSpeech);
// 你开口说话 → 打断正播放的语音，转听你说
window.desktopPet.voice.onSpeakInterrupt(stopSpeech);

setMousePassthrough(true);
initLive2D();
