/**
 * 主进程入口（唯一 Electron 主进程）。
 *
 * ▸ 职责分区（按文件内顺序；已拆模块见各 require）
 *   1. 依赖与全局状态    —— 共享引用/配置/标志（state.isVoiceListening 等），已拆 state.js
 *   2. 窗口辅助          —— windowOptions / placeAtBottomRight / setMainWindowAlwaysOnTop / applyDisplaySettings
 *   3. 主窗(桌宠)        —— createMainWindow（Live2D 角色、白名单点击）
 *   4. 独立气泡窗        —— 已拆 balloons.js（创建/定位/渲染/隐藏）
 *   5. 聊天输入窗        —— open/close/resize/syncChatInputWithMain
 *   6. 菜单窗 + 各设置面板 —— 已拆 panels.js
 *   7. 聊天调度          —— 已拆 chat.js（handleUserUtterance / generateChat / 单句点击回应 / 聊天 IPC / 上下文预算）
 *   8. 长期记忆          —— Graphiti search(注入)+add(回写)（不可用时降级普通聊天）
 *   9. 语音桥接          —— 已拆 voice.js（朗读/识别/打断/语音 IPC）
 *   10. IPC 注册         —— 全部 ipcMain.handle/on（与 preload.js 的 desktopPet.* 一一对应）
 *   11. 状态广播         —— state.isVoiceListening 等共享状态的跨窗口同步
 *   12. 应用生命周期     —— app.whenReady / window-all-closed / activate
 *
 * 主要入口：对话提交走 `chat:submit`；气泡渲染走 `balloon:show` 等；
 * Provider/记忆/外部能力均通过 src/engine 与 src/services 注入，本文件不做具体实现。
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const generic = require('../engine/generic');
const rules = require('../engine/rules');
const personalityRuntime = require('../services/personality-runtime');
const displaySettings = require('../services/display-settings');
const sidecarEnv = require('../services/sidecar-env');
const chatHistory = require('../services/chat-history');
const windowLayout = require('../services/window-layout');
const contextSettings = require('../services/context-settings');
const graphitiMemory = require('../services/graphiti-memory');
const { probeMaxContext } = require('../services/probe-context');
const voiceBridge = require('./voice-bridge');
const { validatePayload, IPC_ERROR } = require('./ipc-validation');
const createPanels = require('./panels');
const state = require('./state');
const createVoice = require('./voice');
const createBalloons = require('./balloons');
const createChat = require('./chat');

const WINDOW = { width: 320, height: 600 };
const config = { dev: process.argv.includes('--dev') };

const CHAT_INPUT_COMPACT_SIZE = { width: 380, height: 112 };
const CHAT_INPUT_EXPANDED_SIZE = { width: 460, height: 560 };
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

// 设置面板 / 菜单窗口模块（依赖注入：动态获取主窗引用 + 统一 webPreferences）
const panels = createPanels({
  getPetWindow: () => state.mainWindow,
  windowOptions,
});

// 语音子系统（朗读合成去重 + 语音识别分发 + 语音 IPC）——依赖注入所需能力
// 注：handleUserUtterance 在 chat 模块创建后才就绪，这里用惰性引用避免 voice ⇄ chat 循环 require。
const chatRef = {};
const voice = createVoice({
  voiceBridge,
  generic,
  sidecarEnv,
  ipcMain,
  state,
  sendToChatInput,
  handleUserUtterance: (text) => (chatRef.handleUserUtterance ? chatRef.handleUserUtterance(text) : undefined),
});

// 独立气泡窗口模块（创建/定位/渲染/隐藏）——依赖注入所需能力
const balloons = createBalloons({ state, windowOptions, config });

// 聊天调度核心模块（多轮对话/单句点击回应/流式广播/上下文压缩预算/聊天 IPC）
const chat = createChat({
  ipcMain,
  state,
  generic,
  chatHistory,
  graphitiMemory,
  contextSettings,
  probeMaxContext,
  voice,
  sendToChatInput,
  windowOps: {
    openChatInputWindow,
    closeChatInputWindow,
    resizeChatInputWindow,
    setMainWindowAlwaysOnTop,
    displaySettings,
  },
  consts: { CHAT_INPUT_COMPACT_SIZE, CHAT_INPUT_EXPANDED_SIZE },
});
chatRef.handleUserUtterance = chat.handleUserUtterance;

function placeAtBottomRight() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const [width, height] = state.mainWindow.getSize();
  state.mainWindow.setPosition(workArea.x + workArea.width - width - 20, workArea.y + workArea.height - height - 20);
}

function setMainWindowAlwaysOnTop(enabled) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  // 层级策略（macOS 层级从高到低：screen-saver > floating > normal）：
  //  - 无对话框：置顶配置开 → screen-saver（高于一切）；关 → normal。
  //  - 紧凑对话框开启：置顶配置开 → floating（仍高于普通应用如微信，但低于对话框），
  //    关 → normal。这样达成“输入框 > 人物 > 微信”。
  //  - 展开对话框开启：人物保持 floating（始终置顶于普通应用），
  //    聊天窗本身转 normal（可被其他应用覆盖、当普通窗口用）。
  let level;
  if (!state.chatInputOpen) {
    level = Boolean(enabled) ? 'screen-saver' : false;
  } else {
    level = Boolean(enabled) ? 'floating' : false;
  }
  const shouldStayVisible = Boolean(level);
  if (shouldStayVisible) state.mainWindow.setAlwaysOnTop(true, level);
  else state.mainWindow.setAlwaysOnTop(false);
  if (typeof state.mainWindow.setVisibleOnAllWorkspaces === 'function') {
    state.mainWindow.setVisibleOnAllWorkspaces(shouldStayVisible, {
      visibleOnFullScreen: shouldStayVisible,
      // 已隐藏 Dock（accessory 辅助应用），跳过默认的进程类型转换，
      // 避免每次调用短暂隐藏窗口/Dock，并确保能加入全屏 Space。
      skipTransformProcessType: true,
    });
  }
}

function applyDisplaySettings(settings, preserveCenter = true) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  const nextWidth = Math.round(WINDOW.width * settings.scale);
  const nextHeight = Math.round(WINDOW.height * settings.scale);
  const bounds = state.mainWindow.getBounds();
  state.mainWindow.setSize(nextWidth, nextHeight);
  if (preserveCenter) {
    state.mainWindow.setPosition(
      Math.round(bounds.x + (bounds.width - nextWidth) / 2),
      Math.round(bounds.y + (bounds.height - nextHeight) / 2),
    );
  }
  setMainWindowAlwaysOnTop(settings.alwaysOnTop);
  if (state.mainWindow.webContents && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('display:changed', settings);
  }
}

function createMainWindow() {
  const settings = displaySettings.getSettings();
  state.mainWindow = new BrowserWindow({
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
  state.mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  placeAtBottomRight();

  if (config.dev) {
    state.mainWindow.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message));
    state.mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}
// 主窗移动时，让打开中的聊天输入窗保持相对位置一起移动（“随人物拖动”）。
// 展开成普通窗口（state.chatInputExpanded）时不跟随，避免与独立使用冲突。
function syncChatInputWithMain() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  const mainBounds = state.mainWindow.getBounds();
  if (!state.lastMainWindowPos) { // 首次：只记录基准，不移动
    state.lastMainWindowPos = { x: mainBounds.x, y: mainBounds.y };
    return;
  }
  if (state.chatInputWindow && !state.chatInputWindow.isDestroyed() && !state.chatInputExpanded) {
    const dx = mainBounds.x - state.lastMainWindowPos.x;
    const dy = mainBounds.y - state.lastMainWindowPos.y;
    if (dx || dy) {
      const [cx, cy] = state.chatInputWindow.getPosition();
      state.chatInputWindow.setPosition(cx + dx, cy + dy);
    }
  }
  state.lastMainWindowPos = { x: mainBounds.x, y: mainBounds.y };
}

// 主窗被移动（系统 moved 事件 或 拖拽 moveTo/moveBy）后统一调用：
// 未拖离的气泡跟随角色头 + 打开中的聊天窗保持相对位置一起拖动。
// 不能只依赖系统 'moved' 事件（编程式 setPosition 在部分平台不可靠）。
function onMainWindowMoved() {
  balloons.positionBalloon(); // 未拖离的贴头顶、已拖离的按相对偏移跟随
  syncChatInputWithMain();
}

function closeChatInputWindow() {
  if (state.chatInputWindow && !state.chatInputWindow.isDestroyed()) {
    saveChatInputPosition(state.chatInputWindow);
    state.chatInputWindow.destroy();
  }
  state.chatInputWindow = null;
  state.chatInputExpanded = false;
  state.chatInputOpen = false;
  // 先置空聊天窗口，再恢复角色置顶，否则会被上面的 state.chatInputOpen 守卫挡住。
  setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
}

function saveChatInputPosition(window) {
  if (!window || window.isDestroyed() || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  const chatBounds = window.getBounds();
  const mainBounds = state.mainWindow.getBounds();
  windowLayout.setLayout({
    chatOffset: { x: chatBounds.x - mainBounds.x, y: chatBounds.y - mainBounds.y },
  });
}

function openChatInputWindow() {
  closeChatInputWindow();
  state.chatInputExpanded = false;
  state.chatInputOpen = true;
  // 角色从 screen-saver 降到 floating：仍高于普通应用（如微信），但低于对话框。
  setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  state.chatInputWindow = new BrowserWindow({
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
  state.chatInputWindow.setAlwaysOnTop(true, 'floating');
  state.chatInputWindow.moveTop();
  state.chatInputWindow.loadFile(path.join(__dirname, '..', 'renderer', 'chat-input.html'));
  state.chatInputWindow.webContents.once('did-finish-load', () => {
    if (!state.chatInputWindow || state.chatInputWindow.isDestroyed()) return;
    state.chatInputWindow.focus();
    state.chatInputWindow.webContents.focus();
  });

  const mainBounds = state.mainWindow && !state.mainWindow.isDestroyed()
    ? state.mainWindow.getBounds()
    : { x: screen.getCursorScreenPoint().x, y: screen.getCursorScreenPoint().y, ...WINDOW };
  const { workArea } = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });
  const [width, height] = state.chatInputWindow.getSize();
  const savedOffset = windowLayout.getLayout().chatOffset;
  const bellyCenterX = mainBounds.x + mainBounds.width / 2;
  const bellyCenterY = mainBounds.y + mainBounds.height * CHAT_INPUT_BELLY_CENTER_RATIO;
  const preferredX = savedOffset ? mainBounds.x + savedOffset.x : bellyCenterX - width / 2;
  const preferredY = savedOffset ? mainBounds.y + savedOffset.y : bellyCenterY - height / 2;
  const x = Math.max(workArea.x + WORK_AREA_MARGIN, Math.min(Math.round(preferredX), workArea.x + workArea.width - width - WORK_AREA_MARGIN));
  const y = Math.max(workArea.y + WORK_AREA_MARGIN, Math.min(Math.round(preferredY), workArea.y + workArea.height - height - WORK_AREA_MARGIN));
  state.chatInputWindow.setPosition(x, y);
  state.chatInputWindow.on('close', () => {
    // 兜底：无论以何种方式关闭对话框，都恢复角色窗口的置顶状态，
    // 避免绕开 closeChatInputWindow() 时角色永久失去 always-on-top。
    const win = state.chatInputWindow;
    state.chatInputWindow = null; // 先置空，让角色层级恢复不被 state.chatInputOpen 守卫挡住
    state.chatInputExpanded = false;
    state.chatInputOpen = false;
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
  if (state.chatInputWindow && !state.chatInputWindow.isDestroyed()) {
    state.chatInputWindow.webContents.send(channel, data);
  }
}
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
ipcMain.handle('personality:openPanel', () => { panels.openPersonalityPanel(); return true; });
ipcMain.handle('personality:closePanel', () => { panels.closePersonalityPanel(); return true; });

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
ipcMain.handle('display:openPanel', () => { panels.openDisplayPanel(); return true; });
ipcMain.handle('display:closePanel', () => { panels.closeDisplayPanel(); return true; });

// 语音设置面板：读写 .env 的 SIDECAR_TTS_*（单一事实源 = .env，与侧车读到的一致）
ipcMain.handle('voiceSettings:get', () => sidecarEnv.read());
ipcMain.handle('voiceSettings:set', guarded('voiceSettings:set', (patch) => {
  const p = { ...patch };
  // 朗读语言改变时，合成语言自动跟随（GPT-SoVITS 按该语言发音）；为空（跟随回复）默认中文。
  if (typeof p.SIDECAR_TTS_SPEAK_LANG === 'string') {
    p.SIDECAR_TTS_TEXT_LANGUAGE = p.SIDECAR_TTS_SPEAK_LANG || 'zh';
  }
  const next = sidecarEnv.write(p);
  // TTS 输出开关是运行时逻辑，无需重启侧车；其余配置变更需要重启让侧车立即生效。
  const needsRestart = Object.keys(p).some((k) => k !== 'SIDECAR_TTS_ENABLED');
  if ('SIDECAR_TTS_ENABLED' in p) state._ttsEnabledCache = p.SIDECAR_TTS_ENABLED !== 'false';
  if (needsRestart && voiceBridge.getStatus().running) voiceBridge.restart(); // 让新配置立即生效
  else if (!needsRestart) voice.broadcastVoiceStatus(); // 开关变化也要让 🔊 图标同步
  return next;
}));
ipcMain.handle('voiceSettings:openPanel', () => { panels.openVoiceSettingsPanel(); return true; });
ipcMain.handle('voiceSettings:closePanel', () => { panels.closeVoiceSettingsPanel(); return true; });

ipcMain.handle('provider:getConfig', () => generic.getProviderConfig());
ipcMain.handle('provider:saveConfig', (_event, config) => {
  try {
    const result = { ok: true, config: generic.saveProviderConfig(config) };
    // provider 变化后重新探测模型上下文上限
    void chat.refreshModelMaxTokens();
    return result;
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle('provider:check', (_event, provider) => generic.checkProvider(provider));
ipcMain.handle('provider:openPanel', () => { panels.openProviderPanel(); return true; });
ipcMain.handle('provider:closePanel', () => { panels.closeProviderPanel(); return true; });

// 上下文设置：探测模型最大上下文 + 滑条控制发送给模型的 token 预算
ipcMain.handle('context:get', async () => {
  const settings = contextSettings.getSettings(state.cachedModelMaxTokens);
  return { ...settings, modelMaxTokens: state.cachedModelMaxTokens };
});
ipcMain.handle('context:set', (event, ...args) => {
  // guard 上限跟随探测到的模型上下文（而不是硬编码 128k），否则探测出更大模型时拉不动滑条
  const result = validatePayload('context:set', args, { contextMaxTokens: contextSettings.getUpperBound(state.cachedModelMaxTokens) });
  return result.ok ? contextSettings.setSettings(result.data[0], state.cachedModelMaxTokens) : IPC_ERROR;
});
ipcMain.handle('context:probe', async () => {
  await chat.refreshModelMaxTokens();
  return state.cachedModelMaxTokens;
});
ipcMain.handle('context:openPanel', () => { panels.openContextPanel(); return true; });
ipcMain.handle('context:closePanel', () => { panels.closeContextPanel(); return true; });

ipcMain.handle('memory:getStatus', async () => graphitiMemory.getStatus());
ipcMain.handle('memory:getSettings', () => graphitiMemory.getSettingsForPanel());
ipcMain.handle('memory:setSettings', guarded('memory:setSettings', (patch) => graphitiMemory.writeSettings(patch)));
ipcMain.handle('memory:openPanel', () => { panels.openMemoryPanel(); return true; });
ipcMain.handle('memory:closePanel', () => { panels.closeMemoryPanel(); return true; });
ipcMain.handle('balloon:show', (_event, payload) => {
  balloons.balloonRender(Object.assign({ action: 'show' }, payload && typeof payload === 'object' ? payload : {}));
  return true;
});
ipcMain.handle('balloon:update', (_event, full) => {
  if (state.balloonWindow && !state.balloonWindow.isDestroyed()) balloons.dispatchBalloonRender({ action: 'update', full: String(full || '') });
  return true;
});
ipcMain.handle('balloon:finish', (_event, payload) => {
  if (state.balloonWindow && !state.balloonWindow.isDestroyed()) {
    const p = payload && typeof payload === 'object' ? payload : {};
    balloons.dispatchBalloonRender({ action: 'finish', text: String(p.text || ''), face: String(p.face || 'idle') });
  }
  return true;
});
ipcMain.handle('balloon:hide', () => { balloons.balloonHide(); return true; });

// renderer 端 onRender 监听注册完成后上报，此时才 flush 加载阶段积压的首条渲染消息
ipcMain.handle('balloon:ready', () => {
  if (state.pendingBalloonRender && state.balloonWindow && !state.balloonWindow.isDestroyed()) {
    state.balloonWindow.webContents.send('balloon:render', state.pendingBalloonRender);
  }
  state.pendingBalloonRender = null;
  return true;
});

ipcMain.handle('balloonWindow:dragMove', (_event, x, y) => {
  if (!state.balloonWindow || state.balloonWindow.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const [width, height] = state.balloonWindow.getSize();
  const pos = balloons.clampToWorkArea({ x, y }, width, height);
  state.balloonFreed = true;
  state.balloonFreedPos = { x: Math.round(pos.x), y: Math.round(pos.y) };
  // 记录气泡相对主窗的偏移，拖走后仍随人物一起移动
  const main = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow.getBounds() : null;
  state.balloonRelToMain = main ? { x: state.balloonFreedPos.x - main.x, y: state.balloonFreedPos.y - main.y } : null;
  state.balloonWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
  return true;
});
ipcMain.handle('balloonWindow:release', () => { state.balloonFreed = true; return true; });
ipcMain.handle('balloonWindow:reanchor', () => {
  state.balloonFreed = false;
  state.balloonFreedPos = null;
  state.balloonRelToMain = null;
  if (state.balloonVisible) balloons.positionBalloon();
  return true;
});

ipcMain.on('window:moveBy', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
  if (win === state.mainWindow) onMainWindowMoved();
});

// 绝对定位：拖拽用屏幕坐标直接 setPosition，避免增量模式下 getPosition 读到陈旧窗口位置导致滞后
ipcMain.on('window:moveTo', (event, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return;
  win.setPosition(Math.round(x), Math.round(y));
  if (win === state.mainWindow) onMainWindowMoved();
});

// 拖拽期间把置顶层级从 screen-saver 降为 floating，避免 macOS 逐帧合成导致闪烁
ipcMain.on('window:setDragState', (event, dragging) => {
  if (typeof dragging !== 'boolean') return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== state.mainWindow) return;
  if (dragging) {
    win.setAlwaysOnTop(true, 'floating');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
    }
  } else {
    setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  }
});

ipcMain.on('window:setMousePassthrough', (event, passthrough) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== state.mainWindow || typeof passthrough !== 'boolean') return;
  if (passthrough) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});

ipcMain.handle('menu:open', (_event, x, y) => {
  panels.openMenuWindow({ x: Number(x) || 0, y: Number(y) || 0 });
  return true;
});
ipcMain.handle('menu:ready', () => panels.repositionMenu());
ipcMain.handle('menu:close', () => { panels.closeMenuWindow(); return true; });
// 统一处理一条用户发言（文本输入或语音识别结果都走这里）：记录历史→流式生成→写回
ipcMain.handle('menu:quit', () => { app.quit(); return true; });

app.whenReady().then(() => {
  // macOS：隐藏 Dock（ActivationPolicyAccessory / UIElementApplication）后，
  // 桌宠窗口才能加入其他应用的全屏 Space 并置顶（普通前台应用进不了全屏 Space）。
  if (process.platform === 'darwin' && app.setActivationPolicy) {
    app.setActivationPolicy('accessory');
  }
  generic.setRuntimePath(path.join(app.getPath('userData'), 'llm-providers.runtime.json'));
  personalityRuntime.setRuntimePath(path.join(app.getPath('userData'), 'personality-runtime.json'));
  displaySettings.setRuntimePath(path.join(app.getPath('userData'), 'display-settings.json'));
  contextSettings.setRuntimePath(path.join(app.getPath('userData'), 'context-settings.json'));
  chatHistory.setRuntimePath(path.join(app.getPath('userData'), 'chat-history.json'));
  windowLayout.setRuntimePath(path.join(app.getPath('userData'), 'window-layout.json'));
  // 启动后异步探测模型最大上下文（不阻塞启动）
  void chat.refreshModelMaxTokens();
  // 启动语音侧车
  voiceBridge.start();
  createMainWindow();
  if (state.mainWindow) {
    // 宠物窗移动时：未拖离的气泡跟随角色头 + 打开中的聊天窗也保持相对位置一起拖动
    state.mainWindow.on('moved', onMainWindowMoved);
    // 首次建立聊天窗跟随基准；之后每次主窗移动由 moved 事件同步
    state.lastMainWindowPos = { x: state.mainWindow.getBounds().x, y: state.mainWindow.getBounds().y };
    state.mainWindow.on('resize', () => balloons.positionBalloon());
  }
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
