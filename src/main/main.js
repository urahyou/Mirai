const { app, BrowserWindow, ipcMain, screen } = require('electron');
const crypto = require('crypto');
const path = require('path');
const generic = require('../engine/generic');
const rules = require('../engine/rules');
const personalityRuntime = require('../services/personality-runtime');
const displaySettings = require('../services/display-settings');
const chatHistory = require('../services/chat-history');
const windowLayout = require('../services/window-layout');
const timemMemory = require('../services/timem-memory');
const { validatePayload, IPC_ERROR } = require('./ipc-validation');

const WINDOW = { width: 320, height: 360 };
const config = { dev: process.argv.includes('--dev') };

let mainWindow = null;
let menuWindow = null;
let menuPendingPosition = null;
let personalityPanelWindow = null;
let providerPanelWindow = null;
let displayPanelWindow = null;
let chatInputWindow = null;
let chatInputExpanded = false;
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
  const shouldStayVisible = Boolean(enabled);
  if (shouldStayVisible) mainWindow.setAlwaysOnTop(true, 'screen-saver');
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

function closeChatInputWindow() {
  setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  if (chatInputWindow && !chatInputWindow.isDestroyed()) {
    saveChatInputPosition(chatInputWindow);
    chatInputWindow.destroy();
  }
  chatInputWindow = null;
  chatInputExpanded = false;
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
  setMainWindowAlwaysOnTop(false);
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
    setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
    if (chatInputWindow && !chatInputWindow.isDestroyed()) saveChatInputPosition(chatInputWindow);
    chatInputWindow = null;
    chatInputExpanded = false;
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
  if (expanded) setMainWindowAlwaysOnTop(false);
  else setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  if (chatInputWindow && !chatInputWindow.isDestroyed()) {
    if (expanded) chatInputWindow.setAlwaysOnTop(false);
    else {
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
ipcMain.handle('chat:submit', async (_event, rawInput) => {
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
  return reply;
});

ipcMain.on('window:moveBy', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
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
ipcMain.handle('menu:quit', () => { app.quit(); return true; });

app.whenReady().then(() => {
  generic.setRuntimePath(path.join(app.getPath('userData'), 'llm-providers.runtime.json'));
  personalityRuntime.setRuntimePath(path.join(app.getPath('userData'), 'personality-runtime.json'));
  displaySettings.setRuntimePath(path.join(app.getPath('userData'), 'display-settings.json'));
  chatHistory.setRuntimePath(path.join(app.getPath('userData'), 'chat-history.json'));
  windowLayout.setRuntimePath(path.join(app.getPath('userData'), 'window-layout.json'));
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
