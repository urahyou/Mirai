/**
 * 主进程入口（唯一 Electron 主进程）。
 *
 * ▸ 职责分区（按文件内顺序；已拆模块见各 require）
 *   1. 依赖与全局状态    —— 共享引用/配置/标志（state.isVoiceListening 等），已拆 state.js
 *   2. 窗口辅助          —— 已拆 windows.js（windowOptions / 主窗创建 / 置顶 / 显示应用 / 聊天输入窗 / 转发）
 *   3. 主窗(桌宠)        —— createMainWindow 已随 windows.js 拆出（Live2D 角色、白名单点击）
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

const { app, BrowserWindow, ipcMain } = require('electron');
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
const createWindows = require('./windows');
const IPC = require('../contracts/ipc');

const WINDOW = { width: 320, height: 600 };
const config = { dev: process.argv.includes('--dev') };
// 统一定制 webPreferences（windows.js 模块级导出，供 panels/balloons 复用）
const windowOptions = createWindows.windowOptions;

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

// 设置面板 / 菜单窗口模块（依赖注入：动态获取主窗引用 + 统一 webPreferences）
const panels = createPanels({
  getPetWindow: () => state.mainWindow,
  windowOptions,
});

// 独立气泡窗口模块（创建/定位/渲染/隐藏）——依赖注入所需能力
const balloons = createBalloons({ state, windowOptions, config });

// 窗口辅助模块（主窗/聊天输入窗的创建、定位、置顶、显示应用、转发）
// ——依赖注入：state(共享窗口引用)、balloons(主窗移动/缩放时气泡跟随)、
//   displaySettings/windowLayout、尺寸常量。
const windows = createWindows({
  state, balloons, displaySettings, windowLayout, config,
  WINDOW, CHAT_INPUT_COMPACT_SIZE, CHAT_INPUT_EXPANDED_SIZE,
  CHAT_INPUT_BELLY_CENTER_RATIO, WORK_AREA_MARGIN,
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
  sendToChatInput: windows.sendToChatInput,
  handleUserUtterance: (text) => (chatRef.handleUserUtterance ? chatRef.handleUserUtterance(text) : undefined),
});

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
  sendToChatInput: windows.sendToChatInput,
  windowOps: {
    openChatInputWindow: windows.openChatInputWindow,
    closeChatInputWindow: windows.closeChatInputWindow,
    resizeChatInputWindow: windows.resizeChatInputWindow,
    setMainWindowAlwaysOnTop: windows.setMainWindowAlwaysOnTop,
    displaySettings,
  },
  consts: { CHAT_INPUT_COMPACT_SIZE, CHAT_INPUT_EXPANDED_SIZE },
});
chatRef.handleUserUtterance = chat.handleUserUtterance;

ipcMain.handle(IPC.PersonalityGet, () => personalityRuntime.getPersonality());
ipcMain.handle(IPC.PersonalitySet, guarded(IPC.PersonalitySet, (patch) => {
  const next = personalityRuntime.setPersonality(patch);
  rules.resetConfig();
  generic.resetConversationHistory();
  return next;
}));
ipcMain.handle(IPC.PersonalityReset, () => {
  const next = personalityRuntime.resetPersonality();
  rules.resetConfig();
  generic.resetConversationHistory();
  return next;
});
ipcMain.handle(IPC.PersonalityOpenPanel, () => { panels.openPersonalityPanel(); return true; });
ipcMain.handle(IPC.PersonalityClosePanel, () => { panels.closePersonalityPanel(); return true; });

ipcMain.handle(IPC.DisplayGet, () => displaySettings.getSettings());
ipcMain.handle(IPC.DisplaySet, guarded(IPC.DisplaySet, (patch) => {
  const next = displaySettings.setSettings(patch);
  windows.applyDisplaySettings(next);
  return next;
}));
ipcMain.handle(IPC.DisplayPreview, guarded(IPC.DisplayPreview, (patch) => {
  const next = { ...displaySettings.getSettings(), ...patch };
  windows.applyDisplaySettings(next);
  return next;
}));
ipcMain.handle(IPC.DisplayOpenPanel, () => { panels.openDisplayPanel(); return true; });
ipcMain.handle(IPC.DisplayClosePanel, () => { panels.closeDisplayPanel(); return true; });

// 语音设置面板：读写 .env 的 SIDECAR_TTS_*（单一事实源 = .env，与侧车读到的一致）
ipcMain.handle(IPC.VoiceSettingsGet, () => sidecarEnv.read());
ipcMain.handle(IPC.VoiceSettingsSet, guarded(IPC.VoiceSettingsSet, (patch) => {
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
ipcMain.handle(IPC.VoiceSettingsOpenPanel, () => { panels.openVoiceSettingsPanel(); return true; });
ipcMain.handle(IPC.VoiceSettingsClosePanel, () => { panels.closeVoiceSettingsPanel(); return true; });

ipcMain.handle(IPC.ProviderGetConfig, () => generic.getProviderConfig());
ipcMain.handle(IPC.ProviderSaveConfig, (_event, config) => {
  try {
    const result = { ok: true, config: generic.saveProviderConfig(config) };
    // provider 变化后重新探测模型上下文上限
    void chat.refreshModelMaxTokens();
    return result;
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle(IPC.ProviderCheck, (_event, provider) => generic.checkProvider(provider));
ipcMain.handle(IPC.ProviderOpenPanel, () => { panels.openProviderPanel(); return true; });
ipcMain.handle(IPC.ProviderClosePanel, () => { panels.closeProviderPanel(); return true; });

// 上下文设置：探测模型最大上下文 + 滑条控制发送给模型的 token 预算
ipcMain.handle(IPC.ContextGet, async () => {
  const settings = contextSettings.getSettings(state.cachedModelMaxTokens);
  return { ...settings, modelMaxTokens: state.cachedModelMaxTokens };
});
ipcMain.handle(IPC.ContextSet, (event, ...args) => {
  // guard 上限跟随探测到的模型上下文（而不是硬编码 128k），否则探测出更大模型时拉不动滑条
  const result = validatePayload(IPC.ContextSet, args, { contextMaxTokens: contextSettings.getUpperBound(state.cachedModelMaxTokens) });
  return result.ok ? contextSettings.setSettings(result.data[0], state.cachedModelMaxTokens) : IPC_ERROR;
});
ipcMain.handle(IPC.ContextProbe, async () => {
  await chat.refreshModelMaxTokens();
  return state.cachedModelMaxTokens;
});
ipcMain.handle(IPC.ContextOpenPanel, () => { panels.openContextPanel(); return true; });
ipcMain.handle(IPC.ContextClosePanel, () => { panels.closeContextPanel(); return true; });

ipcMain.handle(IPC.MemoryGetStatus, async () => graphitiMemory.getStatus());
ipcMain.handle(IPC.MemoryGetSettings, () => graphitiMemory.getSettingsForPanel());
ipcMain.handle(IPC.MemorySetSettings, guarded(IPC.MemorySetSettings, (patch) => graphitiMemory.writeSettings(patch)));
ipcMain.handle(IPC.MemoryOpenPanel, () => { panels.openMemoryPanel(); return true; });
ipcMain.handle(IPC.MemoryClosePanel, () => { panels.closeMemoryPanel(); return true; });
ipcMain.handle(IPC.BalloonShow, (_event, payload) => {
  balloons.balloonRender(Object.assign({ action: 'show' }, payload && typeof payload === 'object' ? payload : {}));
  return true;
});
ipcMain.handle(IPC.BalloonUpdate, (_event, full) => {
  if (state.balloonWindow && !state.balloonWindow.isDestroyed()) balloons.dispatchBalloonRender({ action: 'update', full: String(full || '') });
  return true;
});
ipcMain.handle(IPC.BalloonFinish, (_event, payload) => {
  if (state.balloonWindow && !state.balloonWindow.isDestroyed()) {
    const p = payload && typeof payload === 'object' ? payload : {};
    balloons.dispatchBalloonRender({ action: 'finish', text: String(p.text || ''), face: String(p.face || 'idle') });
  }
  return true;
});
ipcMain.handle(IPC.BalloonHide, () => { balloons.balloonHide(); return true; });

// renderer 端 onRender 监听注册完成后上报，此时才 flush 加载阶段积压的首条渲染消息
ipcMain.handle(IPC.BalloonReady, () => {
  if (state.pendingBalloonRender && state.balloonWindow && !state.balloonWindow.isDestroyed()) {
    state.balloonWindow.webContents.send(IPC.BalloonRender, state.pendingBalloonRender);
  }
  state.pendingBalloonRender = null;
  return true;
});

ipcMain.handle(IPC.BalloonDragMove, (_event, x, y) => {
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
ipcMain.handle(IPC.BalloonRelease, () => { state.balloonFreed = true; return true; });
ipcMain.handle(IPC.BalloonReanchor, () => {
  state.balloonFreed = false;
  state.balloonFreedPos = null;
  state.balloonRelToMain = null;
  if (state.balloonVisible) balloons.positionBalloon();
  return true;
});

ipcMain.on(IPC.WindowMoveBy, (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
  if (win === state.mainWindow) windows.onMainWindowMoved();
});

// 绝对定位：拖拽用屏幕坐标直接 setPosition，避免增量模式下 getPosition 读到陈旧窗口位置导致滞后
ipcMain.on(IPC.WindowMoveTo, (event, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return;
  win.setPosition(Math.round(x), Math.round(y));
  if (win === state.mainWindow) windows.onMainWindowMoved();
});

// 拖拽期间把置顶层级从 screen-saver 降为 floating，避免 macOS 逐帧合成导致闪烁
ipcMain.on(IPC.WindowSetDragState, (event, dragging) => {
  if (typeof dragging !== 'boolean') return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== state.mainWindow) return;
  if (dragging) {
    win.setAlwaysOnTop(true, 'floating');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
    }
  } else {
    windows.setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
  }
});

ipcMain.on(IPC.WindowSetMousePassthrough, (event, passthrough) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== state.mainWindow || typeof passthrough !== 'boolean') return;
  if (passthrough) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});

ipcMain.handle(IPC.MenuOpen, (_event, x, y) => {
  panels.openMenuWindow({ x: Number(x) || 0, y: Number(y) || 0 });
  return true;
});
ipcMain.handle(IPC.MenuReady, () => panels.repositionMenu());
ipcMain.handle(IPC.MenuClose, () => { panels.closeMenuWindow(); return true; });
// 统一处理一条用户发言（文本输入或语音识别结果都走这里）：记录历史→流式生成→写回
ipcMain.handle(IPC.MenuQuit, () => { app.quit(); return true; });

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
  windows.createMainWindow();
  if (state.mainWindow) {
    // 宠物窗移动时：未拖离的气泡跟随角色头 + 打开中的聊天窗也保持相对位置一起拖动
    state.mainWindow.on('moved', windows.onMainWindowMoved);
    // 首次建立聊天窗跟随基准；之后每次主窗移动由 moved 事件同步
    state.lastMainWindowPos = { x: state.mainWindow.getBounds().x, y: state.mainWindow.getBounds().y };
    state.mainWindow.on('resize', () => balloons.positionBalloon());
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  voiceBridge.stop(); // 退出时回收侧车子进程
});
