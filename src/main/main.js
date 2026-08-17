/**
 * 主进程入口（唯一 Electron 主进程）。
 *
 * ▸ 职责分区（按文件内顺序；已拆模块见各 require）
 *   1. 依赖与全局状态    —— 共享引用/配置/标志（state.isVoiceListening 等），已拆 shared-state.js
 *   2. 窗口辅助          —— 已拆 window.js（windowOptions / 主窗创建 / 置顶 / 显示应用 / 聊天输入窗 / 转发）
 *   3. 主窗(桌宠)        —— createMainWindow 已随 window.js 拆出（Live2D 角色、白名单点击）
 *   4. 独立气泡窗        —— 已拆 balloon.js（创建/定位/渲染/隐藏）
 *   5. 聊天输入窗        —— open/close/resize/syncChatInputWithMain
 *   6. 菜单窗 + 各设置面板 —— 已拆 panel.js
 *   7. 聊天调度          —— 已拆 chat.js（handleUserUtterance / generateChat / 单句点击回应 / 聊天 IPC / 上下文预算）
 *   8. 长期记忆          —— Python Core SQLite search(注入)+add(回写)
 *   9. 语音桥接          —— 已拆 voice.js（朗读/识别/打断/语音 IPC）
 *   10. IPC 能力         —— 已拆 src/subsystems/*.js（personality/display/voice/provider/context/memory/balloon/window/menu），本文件仅 mountIpc 装配
 *   11. IPC 校验         —— guarded/validatePayload 集中在 ipc-validation.js
 *   12. 应用生命周期     —— app.whenReady / window-all-closed / activate
 *
 * 主要入口：新建能力 = 在 src/subsystems/ 加一个 setup(api) 并在 index.js 注册。
 * Provider/记忆/外部能力均通过 src/engine 与 src/services 注入，本文件不做具体实现。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
// 必须最先固定应用名：userData 目录名 = app.getName()。
// 放这里（任何其它 require 触及 userData 之前），避免被锁成旧名 haruhana-quest。
// 钉死后目录名一生不变，防止发布期改名导致数据目录漂移。
app.setName('Mirai');
const path = require('path');
const fs = require('fs');
const generic = require('../engine/generic');
const personalityConfig = require('../engine/personality-config');
const personalityRuntime = require('../services/personality-runtime');
const displaySettings = require('../services/display-settings');
const voiceEnv = require('../services/voice-env');
const chatHistory = require('../services/chat-history');
const windowLayout = require('../services/window-layout');
const contextSettings = require('../services/context-budget');
const createCompanionMemory = require('../services/companion-memory');
const createPetStateAdapter = require('../services/pet-state-adapter');
const createCompanionLife = require('../services/companion-life');
const createCompanionEmotion = require('../services/companion-emotion');
const initiativeSettings = require('../services/initiative-settings');
const storage = require('../services/storage');
const { createEventBus } = require('../services/event-bus');
const createPythonBackend = require('../services/python-backend');
const E = require('../contracts/events');
const petState = require('../systems/pet-state');
const sensing = require('../systems/sensing');
const lifeRoutine = require('../systems/life-routine');
const mindRoutine = require('../systems/mind-routine');
const systemSense = require('../systems/system-sense');
const { probeMaxContext } = require('../services/model-context');
const voiceBridge = require('./voice-bridge');
const createPanels = require('./panel');
const state = require('./shared-state');
// 单例事件总线：感知源 emit、领域系统 on（事件类型见 contracts/events.js）
const eventBus = createEventBus();
// Python Companion Core：窗口、IPC 与权限仍留在 Electron 主进程；领域状态逐步迁入此后端。
const pythonBackend = createPythonBackend();
const companionMemory = createCompanionMemory({ pythonBackend });
const companionPetState = createPetStateAdapter({ pythonBackend, fallback: petState });
const companionLife = createCompanionLife({ pythonBackend });
const companionEmotion = createCompanionEmotion({ pythonBackend });
let stopPythonEventMirror = null;
const createVoice = require('./voice');
const createBalloons = require('./balloon');
const createChat = require('./chat');
const createWindows = require('./window');
const mountIpc = require('../subsystems');

const WINDOW = { width: 320, height: 600 };
const config = { dev: process.argv.includes('--dev') };
// 统一定制 webPreferences（window.js 模块级导出，供 panels/balloons 复用）
const windowOptions = createWindows.windowOptions;

const CHAT_INPUT_COMPACT_SIZE = { width: 380, height: 112 };
const CHAT_INPUT_EXPANDED_SIZE = { width: 460, height: 560 };
const CHAT_INPUT_BELLY_CENTER_RATIO = 0.68;
const WORK_AREA_MARGIN = 8;

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

// 设置面板 / 菜单窗口模块（依赖注入：动态获取主窗、统一 webPreferences、临时交互层级）
const panels = createPanels({
  getPetWindow: () => state.mainWindow,
  windowOptions,
  setInteractionWindowActive: windows.setInteractionWindowActive,
});

// 语音子系统（朗读合成去重 + 语音识别分发 + 语音 IPC）——依赖注入所需能力
// 注：handleUserUtterance 在 chat 模块创建后才就绪，这里用惰性引用避免 voice ⇄ chat 循环 require。
const chatRef = {};
const voice = createVoice({
  voiceBridge,
  generic,
  voiceEnv,
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
  memory: companionMemory,
  contextSettings,
  probeMaxContext,
  voice,
  petState: companionPetState,
  lifeState: companionLife,
  emotionState: companionEmotion,
  systemSense,
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

// 注册全部 IPC 能力子系统（personality/display/voice/provider/context/memory/balloon/window/menu）。
// 每个子系统各自 require 纯工具（contracts/ipc、ipc-validation），运行时依赖全部经下面的 api 胶囊注入。
mountIpc({
  ipcMain, app, BrowserWindow,
  state, windows, panels, voice, chat, balloons,
  generic, personalityConfig, personalityRuntime, displaySettings, voiceEnv,
  contextSettings, companionMemory, voiceBridge, eventBus, storage, petState: companionPetState, sensing, systemSense,
  initiativeSettings,
});

// 一次性数据迁移：把旧目录名 haruhana-quest 下的数据搬到当前 userData（Mirai），
// 避免改名后用户已有的日记/好感/记忆等全部丢失。幂等：新目录已有真实数据则跳过。
function migrateLegacyData() {
  const appData = app.getPath('appData');       // …/Application Support（跨平台父目录）
  const legacy = path.join(appData, 'haruhana-quest');
  const current = app.getPath('userData');      // = …/<app.getName()>，通常 …/Mirai
  // Electron 启动即会在 userData 下自建 Local State / GPUCache 等系统文件，
  // 这些不算业务数据，不能据此判定“新目录已有内容”。
  const isElectronSys = (ent) => {
    const k = ent.toLowerCase();
    return k === 'local state' || k === 'cookies' || k === 'sharedfilelist.lock' || k.endsWith('cache');
  };
  console.log('[data] migrate; legacy=%s current=%s', legacy, current);
  try {
    if (path.resolve(legacy) === path.resolve(current)) return;
    if (!fs.existsSync(legacy)) return;
    let hasBusinessData = false;
    if (fs.existsSync(current)) {
      for (const ent of fs.readdirSync(current)) {
        if (!isElectronSys(ent)) { hasBusinessData = true; break; }
      }
    }
    if (hasBusinessData) return; // 新目录已有真实业务数据，避免互相覆盖
    fs.mkdirSync(current, { recursive: true });
    for (const ent of fs.readdirSync(legacy)) {
      const dst = path.join(current, ent);
      const src = path.join(legacy, ent);
      if (!isElectronSys(ent)) {
        // 业务文件：搬到新目录；若同名已存在则保留新目录的、删旧的
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
        else fs.rmSync(src, { recursive: true, force: true });
      } else if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst); // 系统文件：新目录没有才搬，避免覆盖新会话会话数据
      } else {
        fs.rmSync(src, { recursive: true, force: true }); // 系统文件可再生产，删旧的
      }
    }
    // 清理残余并移除旧目录
    for (const ent of fs.readdirSync(legacy)) {
      try { fs.rmSync(path.join(legacy, ent), { recursive: true, force: true }); } catch {}
    }
    try { fs.rmdirSync(legacy); } catch {}
    console.log('[data] 迁移完成，旧目录已移除 →', current);
  } catch (e) {
    console.error('[data] 数据目录迁移失败，请手动处理：', e.stack || e.message);
  }
}

app.whenReady().then(() => {
  // 最先迁移（在一切读写 userData 之前），保证后续路径即新目录且数据已就位。
  migrateLegacyData();
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
  // 统一持久化根目录（JSON 起底，schema 见 src/services/storage.js）
  storage.setRuntimeDir(app.getPath('userData'));
  initiativeSettings.init({ storage });
  // Core 后台启动失败只降级自主能力，不能阻塞桌宠窗口与普通聊天。
  void pythonBackend.start({ dataDir: app.getPath('userData') }).then(async () => {
    const importedMessages = await companionMemory.importMessages(chatHistory.getMessages());
    if (importedMessages) console.log('[companion-core] imported %d existing chat messages', importedMessages);
    await companionPetState.seedFromLegacy();
    await companionLife.advance(Date.now());
    await companionEmotion.refresh(Date.now());
    await lifeRoutine.tick(Date.now());
  })
    .catch((error) => console.warn('[companion-core] 未启动，暂以 Node 兼容路径运行：', error.message));
  // 感知源继续在 Node 侧采集；只镜像低敏感标准化事件给 Python，不发送原始屏幕/音频数据。
  stopPythonEventMirror = eventBus.on(E.SENSING_TICK, ({ now }) => {
    const timestamp = Number(now);
    if (!Number.isFinite(timestamp)) return;
    void pythonBackend.ingest({
      type: E.SENSING_TICK,
      occurredAt: new Date(timestamp).toISOString(),
      source: 'node.sensing',
      privacy: 'local-only',
      payload: { now: timestamp },
    }).catch((error) => console.warn('[companion-core] 感知事件未送达：', error.message));
  });
  // pet 状态系统（情绪/好感/养成，P0-2）
  petState.init({ eventBus });
  companionPetState.init({ eventBus });
  for (const eventType of Object.values(E.PET)) {
    if (eventType !== E.PET.STAGE_UP) eventBus.on(eventType, () => void companionEmotion.refresh(Date.now()));
  }
  // 感知系统：真实时钟/系统状态 → 语境事件（P0-3）
  sensing.init({ eventBus, petState: companionPetState });
  lifeRoutine.init({ eventBus, lifeState: companionLife });
  mindRoutine.init({ eventBus, companionMemory });
  sensing.start();
  // 系统状态感知（P1）：电池/联网/时刻 → 注入对话意识
  systemSense.init();
  systemSense.start();
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
  try { stopPythonEventMirror?.(); } catch {}
  sensing.stop(); // 停止感知心跳
  lifeRoutine.stop(); // 停止生活活动编排
  mindRoutine.stop(); // 停止低频内心活动/夜间梦境编排
  try { systemSense.stop(); } catch {} // 停系统状态轮询
  voiceBridge.stop(); // 退出时回收侧车子进程
  void pythonBackend.stop(); // 回收 Python Core；失败时 bridge 会强制终止子进程
});
