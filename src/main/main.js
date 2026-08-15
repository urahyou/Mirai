const { app, BrowserWindow, ipcMain, screen } = require('electron');
const crypto = require('crypto');
const path = require('path');
const generic = require('../engine/generic');
const rules = require('../engine/rules');
const personalityRuntime = require('../services/personality-runtime');
const displaySettings = require('../services/display-settings');
const sidecarEnv = require('../services/sidecar-env');
const chatHistory = require('../services/chat-history');
const windowLayout = require('../services/window-layout');
const timemMemory = require('../services/timem-memory');
const voiceBridge = require('./voice-bridge');
const { validatePayload, IPC_ERROR } = require('./ipc-validation');

const WINDOW = { width: 320, height: 600 };
const config = { dev: process.argv.includes('--dev') };

let mainWindow = null;
let menuWindow = null;
let menuPendingPosition = null;
let personalityPanelWindow = null;
let providerPanelWindow = null;
let displayPanelWindow = null;
let voiceSettingsPanelWindow = null;
let chatInputWindow = null;
let chatInputExpanded = false;
let chatInputOpen = false;
let chatQueue = Promise.resolve();

const CHAT_INPUT_COMPACT_SIZE = { width: 380, height: 112 };
const CHAT_INPUT_EXPANDED_SIZE = { width: 460, height: 560 };
const MENU_WINDOW_SIZE = { width: 196, height: 244 };
const CHAT_INPUT_BELLY_CENTER_RATIO = 0.68;
const WORK_AREA_MARGIN = 8;

function guarded(channel, handler) {
  return (_event, ...args) => {
    const result = validatePayload(channel, args);
    return result.ok ? handler(...result.data) : IPC_ERROR;
  };
}

function windowOptions(overrides = {}) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, 'preload.js'),
    ...overrides,
  };
}

function placeAtBottomRight() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [width, height] = mainWindow.getSize();
  mainWindow.setPosition(workArea.x + workArea.width - width - 20, workArea.y + workArea.height - height - 20);
}

function setMainWindowAlwaysOnTop(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 层级策略（macOS 层级从高到低：screen-saver > floating > normal）：
  //  - 无对话框：置顶配置开 → screen-saver（高于一切）；关 → normal。
  //  - 紧凑对话框开启：置顶配置开 → floating（仍高于普通应用如微信，但低于对话框），
  //    关 → normal。这样达成“输入框 > 人物 > 微信”。
  //  - 展开对话框开启：人物保持 floating（始终置顶于普通应用），
  //    聊天窗本身转 normal（可被其他应用覆盖、当普通窗口用）。
  let level;
  if (!chatInputOpen) {
    level = Boolean(enabled) ? 'screen-saver' : false;
  } else {
    level = Boolean(enabled) ? 'floating' : false;
  }
  const shouldStayVisible = Boolean(level);
  if (shouldStayVisible) mainWindow.setAlwaysOnTop(true, level);
  else mainWindow.setAlwaysOnTop(false);
  if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
    mainWindow.setVisibleOnAllWorkspaces(shouldStayVisible, {
      visibleOnFullScreen: shouldStayVisible,
    });
  }
}

function applyDisplaySettings(settings, preserveCenter = true) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextWidth = Math.round(WINDOW.width * settings.scale);
  const nextHeight = Math.round(WINDOW.height * settings.scale);
  const bounds = mainWindow.getBounds();
  mainWindow.setSize(nextWidth, nextHeight);
  if (preserveCenter) {
    mainWindow.setPosition(
      Math.round(bounds.x + (bounds.width - nextWidth) / 2),
      Math.round(bounds.y + (bounds.height - nextHeight) / 2),
    );
  }
  setMainWindowAlwaysOnTop(settings.alwaysOnTop);
  if (mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('display:changed', settings);
  }
}

function createMainWindow() {
  const settings = displaySettings.getSettings();
  mainWindow = new BrowserWindow({
    width: Math.round(WINDOW.width * settings.scale),
    height: Math.round(WINDOW.height * settings.scale),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: settings.alwaysOnTop,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: windowOptions(),
  });
  setMainWindowAlwaysOnTop(settings.alwaysOnTop);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  placeAtBottomRight();

  if (config.dev) {
    mainWindow.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message));
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function closeMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuWindow = null;
  menuPendingPosition = null;
}

function positionMenuWindow(point, width = MENU_WINDOW_SIZE.width, height = MENU_WINDOW_SIZE.height) {
  if (!menuWindow || menuWindow.isDestroyed() || !point) return false;
  const { workArea } = screen.getDisplayNearestPoint(point);
  const x = Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width - 8));
  const y = Math.max(workArea.y, Math.min(point.y, workArea.y + workArea.height - height - 8));
  menuWindow.setPosition(Math.round(x), Math.round(y));
  return true;
}

function openMenuWindow(point) {
  closeMenuWindow();
  menuPendingPosition = point;
  menuWindow = new BrowserWindow({
    width: MENU_WINDOW_SIZE.width,
    height: MENU_WINDOW_SIZE.height,
    transparent: true,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: windowOptions(),
  });
  menuWindow.setAlwaysOnTop(true, 'screen-saver');
  positionMenuWindow(point);
  menuWindow.once('ready-to-show', () => {
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.show();
  });
  menuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'menu.html'));
  menuWindow.on('closed', () => { menuWindow = null; });
}

function closePersonalityPanel() {
  if (personalityPanelWindow && !personalityPanelWindow.isDestroyed()) personalityPanelWindow.destroy();
  personalityPanelWindow = null;
}

function openPersonalityPanel() {
  closePersonalityPanel();
  personalityPanelWindow = new BrowserWindow({
    width: 520,
    height: 680,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: windowOptions(),
  });
  personalityPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  personalityPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'personality-panel.html'));
  personalityPanelWindow.on('closed', () => { personalityPanelWindow = null; });
}

function closeProviderPanel() {
  if (providerPanelWindow && !providerPanelWindow.isDestroyed()) providerPanelWindow.destroy();
  providerPanelWindow = null;
}

function openProviderPanel() {
  closeProviderPanel();
  providerPanelWindow = new BrowserWindow({
    width: 760,
    height: 560,
    resizable: true,
    minWidth: 640,
    minHeight: 480,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: windowOptions(),
  });
  providerPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  providerPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'provider-panel.html'));
  providerPanelWindow.on('closed', () => { providerPanelWindow = null; });
}

function closeDisplayPanel() {
  if (displayPanelWindow && !displayPanelWindow.isDestroyed()) displayPanelWindow.destroy();
  displayPanelWindow = null;
}

function openDisplayPanel() {
  closeDisplayPanel();
  displayPanelWindow = new BrowserWindow({
    width: 460,
    height: 360,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: windowOptions(),
  });
  displayPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  displayPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'display-panel.html'));
  displayPanelWindow.on('closed', () => { displayPanelWindow = null; });
}

function closeVoiceSettingsPanel() {
  if (voiceSettingsPanelWindow && !voiceSettingsPanelWindow.isDestroyed()) voiceSettingsPanelWindow.destroy();
  voiceSettingsPanelWindow = null;
}

function openVoiceSettingsPanel() {
  closeVoiceSettingsPanel();
  voiceSettingsPanelWindow = new BrowserWindow({
    width: 480,
    height: 360,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: windowOptions(),
  });
  voiceSettingsPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  voiceSettingsPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'voice-settings.html'));
  voiceSettingsPanelWindow.on('closed', () => { voiceSettingsPanelWindow = null; });
}

function closeChatInputWindow() {
  if (chatInputWindow && !chatInputWindow.isDestroyed()) {
    saveChatInputPosition(chatInputWindow);
    chatInputWindow.destroy();
  }
  chatInputWindow = null;
  chatInputExpanded = false;
  chatInputOpen = false;
  // 先置空聊天窗口，再恢复角色置顶，否则会被上面的 chatInputOpen 守卫挡住。
  setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
}

function saveChatInputPosition(window) {
  if (!window || window.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  const chatBounds = window.getBounds();
  const mainBounds = mainWindow.getBounds();
  windowLayout.setLayout({
    chatOffset: { x: chatBounds.x - mainBounds.x, y: chatBounds.y - mainBounds.y },
  });
}

function openChatInputWindow() {
  closeChatInputWindow();
  chatInputExpanded = false;
  chatInputOpen = true;
  // 角色从 screen-saver 降到 floating：仍高于普通应用（如微信），但低于对话框。
  setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  chatInputWindow = new BrowserWindow({
    width: CHAT_INPUT_COMPACT_SIZE.width,
    height: CHAT_INPUT_COMPACT_SIZE.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: windowOptions(),
  });
  // floating 高于普通应用窗口但低于系统输入法候选窗；输入期间不再改变层级。
  chatInputWindow.setAlwaysOnTop(true, 'floating');
  chatInputWindow.moveTop();
  chatInputWindow.loadFile(path.join(__dirname, '..', 'renderer', 'chat-input.html'));
  chatInputWindow.webContents.once('did-finish-load', () => {
    if (!chatInputWindow || chatInputWindow.isDestroyed()) return;
    chatInputWindow.focus();
    chatInputWindow.webContents.focus();
  });

  const mainBounds = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { x: screen.getCursorScreenPoint().x, y: screen.getCursorScreenPoint().y, ...WINDOW };
  const { workArea } = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
  const [width, height] = chatInputWindow.getSize();
  const savedOffset = windowLayout.getLayout().chatOffset;
  const bellyCenterX = mainBounds.x + mainBounds.width / 2;
  const bellyCenterY = mainBounds.y + mainBounds.height * CHAT_INPUT_BELLY_CENTER_RATIO;
  const preferredX = savedOffset ? mainBounds.x + savedOffset.x : bellyCenterX - width / 2;
  const preferredY = savedOffset ? mainBounds.y + savedOffset.y : bellyCenterY - height / 2;
  const x = Math.max(workArea.x + WORK_AREA_MARGIN, Math.min(Math.round(preferredX), workArea.x + workArea.width - width - WORK_AREA_MARGIN));
  const y = Math.max(workArea.y + WORK_AREA_MARGIN, Math.min(Math.round(preferredY), workArea.y + workArea.height - height - WORK_AREA_MARGIN));
  chatInputWindow.setPosition(x, y);
  chatInputWindow.on('close', () => {
    // 兜底：无论以何种方式关闭对话框，都恢复角色窗口的置顶状态，
    // 避免绕开 closeChatInputWindow() 时角色永久失去 always-on-top。
    const win = chatInputWindow;
    chatInputWindow = null; // 先置空，让角色层级恢复不被 chatInputOpen 守卫挡住
    chatInputExpanded = false;
    chatInputOpen = false;
    if (win && !win.isDestroyed()) saveChatInputPosition(win);
    setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  });
}

function resizeChatInputWindow(win, width, height) {
  if (!win || win.isDestroyed()) return false;
  const [x, y] = win.getPosition();
  const [, currentHeight] = win.getContentSize();
  const bottom = y + currentHeight;
  const { workArea } = screen.getDisplayNearestPoint({ x, y });
  const nextX = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8));
  const nextY = Math.max(
    workArea.y + 8,
    Math.min(bottom - height, workArea.y + workArea.height - height - 8),
  );
  win.setContentSize(width, height);
  win.setPosition(nextX, nextY);
  return true;
}

function sendToChatInput(channel, data) {
  if (chatInputWindow && !chatInputWindow.isDestroyed()) {
    chatInputWindow.webContents.send(channel, data);
  }
}

function broadcastChatDelta(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:delta', data);
  sendToChatInput('chat:delta', data);
}

function enqueueChat(work) {
  const run = chatQueue.then(work, work);
  chatQueue = run.catch(() => {});
  return run;
}

async function generatePetLine(purpose) {
  for (const provider of generic.providerChain()) {
    try {
      if (!(await generic.isAvailable(provider))) continue;
      const line = await generic.generatePetLine({ provider, purpose });
      if (line.trim()) return line.trim();
    } catch {
      // Try the next configured provider.
    }
  }
  return '';
}

async function generateChat(input, emit) {
  const memories = await timemMemory.search(input);
  const memoryContext = timemMemory.formatContext(memories);
  for (const provider of generic.providerChain()) {
    try {
      if (!(await generic.isAvailable(provider))) continue;
      return await generic.generateReply(input, { provider, onDelta: emit, memoryContext });
    } catch {
      // Try the next configured provider.
    }
  }
  return '现在没能连上本地模型，稍后再和我聊聊吧。';
}

ipcMain.handle('character:greet', async () => {
  const reply = await generatePetLine('click');
  if (reply) {
    const message = chatHistory.appendMessage('assistant', reply);
    sendToChatInput('chat:history', { message, source: 'interaction' });
    speak(reply);
  }
  return reply;
});

ipcMain.handle('personality:get', () => personalityRuntime.getPersonality());
ipcMain.handle('personality:set', guarded('personality:set', (patch) => {
  const next = personalityRuntime.setPersonality(patch);
  rules.resetConfig();
  generic.resetConversationHistory();
  return next;
}));
ipcMain.handle('personality:reset', () => {
  const next = personalityRuntime.resetPersonality();
  rules.resetConfig();
  generic.resetConversationHistory();
  return next;
});
ipcMain.handle('personality:openPanel', () => { openPersonalityPanel(); return true; });
ipcMain.handle('personality:closePanel', () => { closePersonalityPanel(); return true; });

ipcMain.handle('display:get', () => displaySettings.getSettings());
ipcMain.handle('display:set', guarded('display:set', (patch) => {
  const next = displaySettings.setSettings(patch);
  applyDisplaySettings(next);
  return next;
}));
ipcMain.handle('display:preview', guarded('display:preview', (patch) => {
  const next = { ...displaySettings.getSettings(), ...patch };
  applyDisplaySettings(next);
  return next;
}));
ipcMain.handle('display:openPanel', () => { openDisplayPanel(); return true; });
ipcMain.handle('display:closePanel', () => { closeDisplayPanel(); return true; });

// 语音设置面板：读写 .env 的 SIDECAR_TTS_*（单一事实源 = .env，与侧车读到的一致）
ipcMain.handle('voiceSettings:get', () => sidecarEnv.read());
ipcMain.handle('voiceSettings:set', guarded('voiceSettings:set', (patch) => {
  const p = { ...patch };
  // 朗读语言改变时，合成语言自动跟随（GPT-SoVITS 按该语言发音）；为空（跟随回复）默认中文。
  if (typeof p.SIDECAR_TTS_SPEAK_LANG === 'string') {
    p.SIDECAR_TTS_TEXT_LANGUAGE = p.SIDECAR_TTS_SPEAK_LANG || 'zh';
  }
  const next = sidecarEnv.write(p);
  if (voiceBridge.getStatus().running) voiceBridge.restart(); // 让新配置立即生效
  return next;
}));
ipcMain.handle('voiceSettings:openPanel', () => { openVoiceSettingsPanel(); return true; });
ipcMain.handle('voiceSettings:closePanel', () => { closeVoiceSettingsPanel(); return true; });

ipcMain.handle('provider:getConfig', () => generic.getProviderConfig());
ipcMain.handle('provider:saveConfig', (_event, config) => {
  try {
    return { ok: true, config: generic.saveProviderConfig(config) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle('provider:check', (_event, provider) => generic.checkProvider(provider));
ipcMain.handle('provider:openPanel', () => { openProviderPanel(); return true; });
ipcMain.handle('provider:closePanel', () => { closeProviderPanel(); return true; });

ipcMain.handle('chat:openInput', () => { openChatInputWindow(); return true; });
ipcMain.handle('chat:closeInput', () => { closeChatInputWindow(); return true; });
ipcMain.handle('chat:getHistory', () => chatHistory.getMessages());
ipcMain.handle('memory:getStatus', () => timemMemory.getStatus());
ipcMain.handle('chat:setExpanded', guarded('chat:setExpanded', (expanded) => {
  chatInputExpanded = expanded;
  if (chatInputWindow && !chatInputWindow.isDestroyed()) {
    if (expanded) {
      // 展开成普通窗口：聊天窗可被覆盖；人物保持 floating 置顶（不消失）
      setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
      chatInputWindow.setAlwaysOnTop(false);
    } else {
      // 收起成悬浮输入框：角色降到 floating（仍高于微信），对话浮动在人物之上
      setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
      chatInputWindow.setAlwaysOnTop(true, 'floating');
      chatInputWindow.moveTop();
    }
  }
  const target = expanded ? CHAT_INPUT_EXPANDED_SIZE : CHAT_INPUT_COMPACT_SIZE;
  return resizeChatInputWindow(chatInputWindow, target.width, target.height);
}));
ipcMain.handle('chat:resizeInput', (event, requestedHeight) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  if (win !== chatInputWindow || chatInputExpanded) return true;
  const height = Math.max(96, Math.min(220, Math.round(Number(requestedHeight) || 96)));
  const [width] = win.getContentSize();
  return resizeChatInputWindow(win, width, height);
});
ipcMain.handle('chat:submit', async (_event, rawInput) => handleUserUtterance(rawInput));

ipcMain.on('window:moveBy', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// 绝对定位：拖拽用屏幕坐标直接 setPosition，避免增量模式下 getPosition 读到陈旧窗口位置导致滞后
ipcMain.on('window:moveTo', (event, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return;
  win.setPosition(Math.round(x), Math.round(y));
});

// 拖拽期间把置顶层级从 screen-saver 降为 floating，避免 macOS 逐帧合成导致闪烁
ipcMain.on('window:setDragState', (event, dragging) => {
  if (typeof dragging !== 'boolean') return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== mainWindow) return;
  if (dragging) {
    win.setAlwaysOnTop(true, 'floating');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    }
  } else {
    setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  }
});

ipcMain.on('window:setMousePassthrough', (event, passthrough) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== mainWindow || typeof passthrough !== 'boolean') return;
  if (passthrough) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});

ipcMain.handle('menu:open', (_event, x, y) => {
  openMenuWindow({ x: Number(x) || 0, y: Number(y) || 0 });
  return true;
});
ipcMain.handle('menu:ready', () => {
  if (!menuWindow || menuWindow.isDestroyed() || !menuPendingPosition) return false;
  const [width, height] = menuWindow.getContentSize();
  return positionMenuWindow(menuPendingPosition, width, height);
});
ipcMain.handle('menu:close', () => { closeMenuWindow(); return true; });
// 统一处理一条用户发言（文本输入或语音识别结果都走这里）：记录历史→流式生成→写回
async function handleUserUtterance(rawInput) {
  const input = String(rawInput || '').trim().slice(0, 4000);
  if (!input) return '';
  const turnId = crypto.randomUUID();
  const userMessage = chatHistory.appendMessage('user', input);
  sendToChatInput('chat:history', { message: userMessage, turnId });
  broadcastChatDelta({ started: true, done: false, turnId });
  const emit = (chunk, full) => {
    broadcastChatDelta({ chunk, full, done: false, turnId });
  };
  const reply = await enqueueChat(() => generateChat(input, emit));
  const assistantMessage = chatHistory.appendMessage('assistant', reply);
  void timemMemory.add([{ role: 'user', content: input }, { role: 'assistant', content: reply }]);
  sendToChatInput('chat:history', { message: assistantMessage, turnId });
  broadcastChatDelta({ chunk: '', full: reply, done: true, turnId });
  // 语音输出：让小未来开口说这句回复
  speak(reply);
  return reply;
}

// 让小未来开口（把文字交给侧车合成并播放）
// 若 .env 设了 SIDECAR_TTS_SPEAK_LANG（如 ja=日语），则先把“中文回复”翻成该语言再发音；
// 屏幕上显示的气泡文字（chatHistory/chat-input）保持中文不变 —— 实现“中文文字 + 外语朗读”。
function speak(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const speakLang = String(voiceBridge.getSidecarEnv().SIDECAR_TTS_SPEAK_LANG || '').trim();
  if (speakLang) {
    // 先翻译再发音，失败则回退原话，避免没声
    generic.translate(t, speakLang)
      .then((jp) => voiceBridge.speak((jp && jp.trim()) ? jp : t))
      .catch(() => voiceBridge.speak(t));
    return;
  }
  voiceBridge.speak(t);
}

// 语音识别结果直接交给统一发言流程
const isVoiceListening = { value: false };

// 向两个窗口广播语音状态（聆听开关 + 侧车就绪度），供 🎤 按钮显示 加载中/就绪
function broadcastVoiceStatus() {
  const status = { ...voiceBridge.getStatus(), listening: isVoiceListening.value };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:status', status);
  sendToChatInput('voice:status', status);
}

// 向两个窗口广播聆听开关状态（宠物窗 + 对话窗）
function broadcastVoiceListening() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:listening-changed', isVoiceListening.value);
  sendToChatInput('voice:listening-changed', isVoiceListening.value);
}

function setVoiceListening(on) {
  isVoiceListening.value = Boolean(on);
  if (isVoiceListening.value) voiceBridge.start();
  broadcastVoiceListening();
  broadcastVoiceStatus();
}

// 侧车就绪/退出 → 刷新两侧 🎤 状态（加载中⇄就绪）
voiceBridge.on('ready-change', broadcastVoiceStatus);

// 飘字：实时部分识别 → 填进对话窗输入框（说话文字显示在“输入对话框”）
voiceBridge.on('asr-partial', (text) => {
  if (!isVoiceListening.value) return;
  sendToChatInput('voice:asr-partial', text);
});

// 最终识别：对话窗开着→填输入框（是否自动发送由对话窗决定）；对话窗关着→直接自动发送（回复走气泡）
voiceBridge.on('asr', (text) => {
  if (!isVoiceListening.value) return;
  const t = String(text || '').trim();
  if (!t) return;
  if (chatInputOpen) sendToChatInput('voice:asr-final', t);
  else void handleUserUtterance(t);
});

// 让主窗口（宠物窗）播放小未来的语音
voiceBridge.on('audio', (audio) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('voice:audio', {
      id: audio.id,
      format: audio.format || 'mp3',
      data: audio.data, // Buffer → 序列化为 Uint8Array，renderer 端解码播放
    });
  }
});

// 你开口说话时（speech_start）→ 通知宠物窗打断正在播放的语音，转听你说
voiceBridge.on('vad', (state) => {
  if (state === 'speech_start' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('voice:speak-interrupt');
  }
});

// 让小未来开口（外部显式触发）
ipcMain.handle('voice:speak', (_event, text) => {
  voiceBridge.speak(text);
  return true;
});

ipcMain.handle('voice:start', () => {
  voiceBridge.start();
  return voiceBridge.getStatus();
});
ipcMain.handle('voice:stop', () => {
  voiceBridge.stop();
  return true;
});
ipcMain.handle('voice:getStatus', () => ({ ...voiceBridge.getStatus(), listening: isVoiceListening.value }));
ipcMain.handle('voice:setListening', (_event, on) => {
  setVoiceListening(on);
  return isVoiceListening.value;
});
ipcMain.on('voice:pcm', (_event, buffer) => voiceBridge.sendPcm(buffer));

ipcMain.handle('menu:quit', () => { app.quit(); return true; });

app.whenReady().then(() => {
  generic.setRuntimePath(path.join(app.getPath('userData'), 'llm-providers.runtime.json'));
  personalityRuntime.setRuntimePath(path.join(app.getPath('userData'), 'personality-runtime.json'));
  displaySettings.setRuntimePath(path.join(app.getPath('userData'), 'display-settings.json'));
  chatHistory.setRuntimePath(path.join(app.getPath('userData'), 'chat-history.json'));
  windowLayout.setRuntimePath(path.join(app.getPath('userData'), 'window-layout.json'));
  // 启动语音侧车
  voiceBridge.start();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  voiceBridge.stop(); // 退出时回收侧车子进程
});
