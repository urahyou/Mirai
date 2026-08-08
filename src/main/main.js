const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const rules = require('../engine/rules');
const generic = require('../engine/generic');
const { createEmotionService } = require('../core/emotion-state');
const { createProactivePolicy } = require('../services/proactive-policy');
const { createProactiveSettingsStore } = require('../services/proactive-settings-store');
const { createMemoryService } = require('../services/memory-service');
const { createMemoryStore } = require('../services/memory-store');
const { createSettingsStore } = require('../services/settings-store');
const { createOwnerStore } = require('../services/owner-store');
const personalityRuntime = require('../services/personality-runtime');
const { createJsonStorage } = require('../services/json-storage');
const { createSchedulerService, TYPES } = require('../services/scheduler-service');
const { reminderGate } = require('../services/reminder-gate');
const { validatePayload, IPC_ERROR } = require('./ipc-validation');
const { parseMemoryIntent, MEMORY_LABELS } = require('../services/memory-intent');
const { run: runMemoryJudge } = require('../services/memory-judge');
const { runReflection } = require('../services/memory-reflection');
const { MOOD_MAP } = require('../core/mood-map');

let mainWindow = null;
let emotionService = null;
let menuWindow = null;
let menuPendingPos = null;
let providerPanelWindow = null;
let settingsPanelWindow = null;
let schedulePanelWindow = null;
let ownerPanelWindow = null;
let personalityPanelWindow = null;
let chatInputWindow = null;
let chatInputLastPosition = null;
let proactiveSettingsStore = null;
let proactivePolicy = null;
let memoryService = null;
let settingsStore = null;
let ownerStore = null;
let schedulerService = null;
let reminderTimer = null;
let hideTimer = null;
const proactivePromptHistory = [];

// ---- 方案 C · P2：自动沉淀（Memory Judge）----
// 后台异步提炼值得长期记住的信息；带节流、不进聊天队列、失败静默。
const AUTO_MEMORY_MIN_INTERVAL_MS = 60000;
let lastAutoMemoryAt = 0;
let autoMemoryRun = Promise.resolve();

// P3 反思压缩：每累计 N 轮对话 + 最小间隔节流触发一次（与自动沉淀同队列串行写文件）
const REFLECTION_EVERY_N_EVENTS = 40;
const REFLECTION_MIN_INTERVAL_MS = 6 * 3600 * 1000;
let lastReflectionAt = 0;
let reflectionEventCount = 0;
function scheduleReflection(provider) {
  if (!memoryService) return;
  const settings = settingsStore && settingsStore.get();
  // 与自动沉淀同闸：关闭 memoryAuto 时不动记忆
  if (settings && settings.memoryAuto === false) return;
  reflectionEventCount += 1;
  const now = Date.now();
  if (now - lastReflectionAt < REFLECTION_MIN_INTERVAL_MS) return;
  if (reflectionEventCount < REFLECTION_EVERY_N_EVENTS) return;
  reflectionEventCount = 0;
  lastReflectionAt = now;
  autoMemoryRun = autoMemoryRun
    .then(() => runReflection({ service: memoryService, provider }))
    .catch((err) => console.log('[memory-reflection] skipped:', err && err.message));
}

// 用 ipc-validation 守卫一条 IPC 请求：非法 payload 统一返回 IPC_ERROR。
// handler 接收规范化后的位置参数（data 数组展开），不再直接吃原始 event。
function guarded(channel, handler) {
  return (event, ...args) => {
    const result = validatePayload(channel, args);
    if (!result.ok) return IPC_ERROR;
    return handler(...result.data);
  };
}

const WINDOW = {
  width: 320,
  height: 360,
  // 角色实际占桌面区域：人物立绘通常在下半部分，气泡在上半部分
};

const config = {
  dev: process.argv.includes('--dev'),
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 开发模式下打印渲染进程错误
  if (config.dev) {
    mainWindow.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer]', message);
    });
  }

  if (config.dev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 默认放到屏幕右下角
  placeAtBottomRight();
}

function placeAtBottomRight() {
  const { screen } = require('electron');
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { workArea } = display;
  const [w, h] = mainWindow.getSize();
  mainWindow.setPosition(
    workArea.x + workArea.width - w - 20,
    workArea.y + workArea.height - h - 20
  );
}

function hideWindow() {
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.hide();
  }
}

function showWindow() {
  clearTimeout(hideTimer);
  hideTimer = null;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
}

// 隐藏后通过全局快捷键恢复；否则角色隐藏便无处找回（无托盘）。
const SHOW_SHORTCUT = 'CommandOrControl+Shift+Alt+P';

function toggleWindowVisibility() {
  if (mainWindow && mainWindow.isVisible()) {
    hideWindow();
  } else {
    showWindow();
    notify('我回来了！');
  }
}

function registerShowShortcut() {
  const { globalShortcut } = require('electron');
  if (globalShortcut.isRegistered(SHOW_SHORTCUT)) globalShortcut.unregister(SHOW_SHORTCUT);
  try {
    globalShortcut.register(SHOW_SHORTCUT, toggleWindowVisibility);
  } catch (err) {
    console.error('无法注册显影快捷键:', err);
  }
}

function unregisterShowShortcut() {
  const { globalShortcut } = require('electron');
  if (globalShortcut.isRegistered(SHOW_SHORTCUT)) globalShortcut.unregister(SHOW_SHORTCUT);
}

// 主窗口气泡反馈（主进程事件驱动，不依赖 IPC 返回值）
function notify(text, face = 'happy') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('toast:show', { text, face });
  }
}

function memoryCounts() {
  if (!memoryService) return { core: 0, working: 0, summaries: 0 };
  try {
    const all = memoryService.list({ includeArchived: true });
    return {
      core: all.filter((m) => m.status === 'core' && !m.deletedAt).length,
      working: all.filter((m) => m.status !== 'core' && m.status !== 'compressed' && !m.deletedAt && !m.archivedAt).length,
      summaries: all.filter((m) => m.isSummary && !m.deletedAt && !m.archivedAt).length,
    };
  } catch { return { core: 0, working: 0, summaries: 0 }; }
}

function publishState() {
  if (mainWindow && emotionService) {
    mainWindow.webContents.send('state:changed', { ...emotionService.getState(), memoryCounts: memoryCounts() });
  }
}

function recordEmotionEvent(type, delta) {
  if (!emotionService) return null;
  const state = emotionService.recordEvent(type, delta);
  publishState();
  return state;
}

// ---------- IPC ----------

// 返回右键菜单需要的数据（供渲染进程渲染自定义 HTML 菜单）
ipcMain.handle('menu:data', () => {
  const providers = generic.listProviders();
  const active = generic.getActiveProvider();
  return {
    activeProvider: active.name,
    providers,
  };
});

// 切换 Provider
ipcMain.handle('menu:setProvider', (_e, name) => {
  const ok = generic.setActiveProvider(name);
  notify(ok ? `已切换到 ${generic.getActiveProvider().label}` : 'Provider 切换失败');
  return ok;
});

// 重置位置
ipcMain.handle('menu:resetPosition', () => {
  placeAtBottomRight();
  notify('已重置到右下角');
  return true;
});

// 隐藏角色（可通过全局快捷键恢复显示）
ipcMain.handle('menu:hide', () => {
  notify(`已隐藏，按 ${SHOW_SHORTCUT.replace('CommandOrControl+', '')} 可恢复显示`);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideWindow();
    hideTimer = null;
  }, 1600);
  return true;
});

// 退出应用
ipcMain.handle('menu:quit', () => {
  app.quit();
  return true;
});

ipcMain.handle('menu:clearMemory', () => {
  generic.clearHistory();
  if (memoryService) memoryService.clearAll();
  notify('记忆已清空，我会重新认识你');
  return true;
});

// 屏幕工作区（用于菜单边界限制）
const { screen } = require('electron');
ipcMain.handle('screen:workArea', () => {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return workArea;
});

ipcMain.handle('character:greet', async () => {
  recordEmotionEvent('USER_GREETING', { moodScore: 3, affection: 1, loneliness: -3, stress: -1 });
  for (const name of generic.providerChain()) {
    try {
      const available = await generic.isAvailable(name);
      if (!available) continue;
      const line = await generic.generatePetLine({
        provider: name,
        purpose: 'click',
        emotionState: emotionService ? emotionService.getState() : null,
        ownerName: ownerStore.get().name,
      });
      if (line && line.trim()) return line.trim();
    } catch {
      /* 尝试下一个 */
    }
  }
  return '';
});

// 开场白问候（大模型生成，区分是否已认识主人）
ipcMain.handle('character:greeting', async () => {
  const ownerName = ownerStore.get().name;
  for (const name of generic.providerChain()) {
    try {
      const available = await generic.isAvailable(name);
      if (!available) continue;
      const line = await generic.generatePetLine({
        provider: name,
        purpose: 'greeting',
        emotionState: emotionService ? emotionService.getState() : null,
        ownerName,
      });
      if (line && line.trim()) return { line: line.trim(), known: Boolean(ownerName) };
    } catch {
      /* 尝试下一个 */
    }
  }
  return { line: '', known: Boolean(ownerName) };
});

ipcMain.handle('proactive:getSettings', () => {
  return proactiveSettingsStore.get();
});

ipcMain.handle('proactive:setSettings', guarded('proactive:setSettings', (settings) => {
  return proactiveSettingsStore.set(settings);
}));

ipcMain.handle('proactive:pause', guarded('proactive:pause', (pausedUntil) => {
  return proactiveSettingsStore.set({ pausedUntil });
}));

ipcMain.handle('proactive:resume', guarded('proactive:resume', () => {
  return proactiveSettingsStore.set({ pausedUntil: null });
}));

// 设置面板（跨重启保存）
ipcMain.handle('settings:get', () => settingsStore.get());

ipcMain.handle('settings:set', guarded('settings:set', (settings) => settingsStore.set(settings)));

// 关于主人（owner.json）
ipcMain.handle('owner:get', () => ownerStore.get());

ipcMain.handle('owner:set', guarded('owner:set', (patch) => ownerStore.set(patch)));

// 小未来的性格（personality-runtime.json，保存后立即刷新规则引擎缓存）
ipcMain.handle('personality:get', () => personalityRuntime.getPersonality());

ipcMain.handle('personality:set', guarded('personality:set', (patch) => {
  const next = personalityRuntime.setPersonality(patch);
  rules.resetConfig();
  return next;
}));

ipcMain.handle('personality:reset', () => {
  const next = personalityRuntime.resetPersonality();
  rules.resetConfig();
  return next;
});

ipcMain.handle('owner:openPanel', () => {
  openOwnerPanel();
  return true;
});

ipcMain.handle('owner:closePanel', () => {
  closeOwnerPanel();
  return true;
});

ipcMain.handle('personality:openPanel', () => {
  openPersonalityPanel();
  return true;
});

ipcMain.handle('personality:closePanel', () => {
  closePersonalityPanel();
  return true;
});

ipcMain.handle('proactive:decide', async (e) => {
  const now = new Date();
  let content = '';
  const nullDecision = { shouldPrompt: false, reason: 'no-provider' };
  for (const name of generic.providerChain()) {
    try {
      const available = await generic.isAvailable(name);
      if (!available) continue;
      const line = await generic.generatePetLine({
        provider: name,
        purpose: 'idle',
        emotionState: emotionService ? emotionService.getState() : null,
        ownerName: ownerStore.get().name,
      });
      if (line && line.trim()) {
        content = line.trim();
        break;
      }
    } catch {
      /* 尝试下一个 */
    }
  }
  if (!content) {
    const emptyResult = { ...nullDecision, reason: 'llm-unavailable' };
    e.sender.send('proactive:decide', emptyResult);
    return emptyResult;
  }
  const decision = proactivePolicy.decide({ now, content, promptHistory: proactivePromptHistory });
  const result = decision.shouldPrompt ? { ...decision, content } : decision;
  if (decision.shouldPrompt) {
    proactivePromptHistory.push({ at: now.toISOString(), content });
  }
  e.sender.send('proactive:decide', result);
  return result;
});

ipcMain.handle('memory:list', guarded('memory:list', (filter) => memoryService.list(filter)));

ipcMain.handle('memory:remember', guarded('memory:remember', (memory) => memoryService.remember(memory)));

ipcMain.handle('memory:update', guarded('memory:update', (id, changes) => memoryService.update(id, changes)));

ipcMain.handle('memory:remove', guarded('memory:remove', (id) => memoryService.remove(id)));

ipcMain.handle('memory:forget', guarded('memory:forget', (request) => memoryService.forget(request)));

ipcMain.handle('memory:doNotRemember', guarded('memory:doNotRemember', (request) => memoryService.doNotRemember(request)));

ipcMain.handle('memory:archive', guarded('memory:archive', (id) => memoryService.archive(id)));

ipcMain.handle('memory:archiveExpired', guarded('memory:archiveExpired', () => memoryService.archiveExpired()));

ipcMain.handle('memory:export', guarded('memory:export', () => memoryService.exportData()));

ipcMain.handle('memory:clearAll', guarded('memory:clearAll', () => {
  if (memoryService) { memoryService.clearAll(); memoryJudgeLog.length = 0; }
  return true;
}));

// 记忆库统计 + 自动记忆审计（U3 记忆库）
ipcMain.handle('memory:stats', guarded('memory:stats', () => {
  if (!memoryService) return null;
  const all = memoryService.list({ includeArchived: true });
  const trash = memoryService.list({ trashOnly: true });
  const settings = settingsStore ? settingsStore.get() : {};
  return {
    counts: {
      core: all.filter((m) => m.status === 'core').length,
      active: all.filter((m) => m.status !== 'core' && !m.archivedAt).length,
      archived: all.filter((m) => m.archivedAt).length,
      trash: trash.length,
      blocked: (memoryService.blocked && memoryService.blocked().length) || 0,
      total: all.length + trash.length,
    },
    bySource: {
      judge: all.filter((m) => m.source === 'judge').length,
      manual: all.filter((m) => m.source !== 'judge').length,
    },
    hygiene: memoryService.hygiene(),
    memoryAuto: settings.memoryAuto !== false,
    memoryAutoInterval: settings.memoryAutoInterval || 60000,
    judgeLog: memoryJudgeLog.slice(0, 10),
  };
}));

ipcMain.handle('memory:restore', guarded('memory:restore', (id) => memoryService.restore(id)));
ipcMain.handle('memory:purge', guarded('memory:purge', (id) => memoryService.purge(id)));

// 记忆意图 → 直接操作记忆服务，不经过普通 LLM。
function handleMemoryIntent(intent) {
  switch (intent.kind) {
    case 'remember': {
      const stored = memoryService.remember({ type: intent.type, content: intent.content, explicit: true, source: 'conversation' });
      return stored
        ? { source: 'memory', reply: `好呀，我记住了：${intent.content}` }
        : { source: 'memory', reply: '这个我先不记了，里面有些内容我拿不准。' };
    }
    case 'forget': {
      if (!intent.content) return { source: 'memory', reply: '嗯…要我忘记哪件事？说得具体一点，比如「忘记我订的航班」。' };
      const removed = memoryService.forget({ type: intent.type, content: intent.content });
      return removed
        ? { source: 'memory', reply: `好，这件事已经忘掉了。` }
        : { source: 'memory', reply: '我好像没有这方面的记忆呢。' };
    }
    case 'doNotRemember': {
      memoryService.doNotRemember({ type: intent.type, content: intent.content });
      return { source: 'memory', reply: '明白，以后这类东西我不会再记了。' };
    }
    case 'recall': {
      const entries = memoryService.list();
      if (entries.length === 0) return { source: 'memory', reply: '我现在的记忆还是空的呢。' };
      const preview = entries.slice(0, 5).map((m) => `· ${MEMORY_LABELS[m.type] || m.type}：${m.content}`).join('\n');
      return { source: 'memory', reply: `我记得这些：\n${preview}` };
    }
    default:
      return null;
  }
}

function memoryContextFor(input) {
  const networkAllowed = settingsStore && settingsStore.get().networkConsent === true;
  // 方案 C 分层：返回 { core, working } 两段（core=常驻画像，working=动态检索）。
  return memoryService.buildLayeredContext({ query: input, networkAllowed });
}

// 自动沉淀入口：对话得到回复后，后台让 LLM 判断有无值得长期记住的信息。
// - 记忆命令 / 主人称呼声明等已由专门流程处理，不重复提炼
// - 节流：至少间隔 AUTO_MEMORY_MIN_INTERVAL_MS 才提炼一次（可由 settings.memoryAutoInterval 覆盖），避免每轮烧 LLM
// - 后台串行队列，不参与对话串行队列、不阻塞回复；失败静默
function scheduleAutoMemory(userInput, reply, provider) {
  if (!memoryService) return;
  const settings = settingsStore && settingsStore.get();
  // 总开关：用户在菜单/面板关闭自动沉淀时，整条链路静默跳过（不打日志避免每轮刷屏）
  if (settings && settings.memoryAuto === false) return;
  if (parseMemoryIntent(userInput).kind !== 'none') { console.log('[memory-judge] skip: memory/command intent'); return; }
  if (extractOwnerName(userInput)) { console.log('[memory-judge] skip: owner intro'); return; }
  const interval = (settings && settings.memoryAutoInterval) || AUTO_MEMORY_MIN_INTERVAL_MS;
  const now = Date.now();
  if (now - lastAutoMemoryAt < interval) { console.log('[memory-judge] skip: throttled'); return; }
  lastAutoMemoryAt = now;
  console.log('[memory-judge] scheduling auto extraction');
  autoMemoryRun = autoMemoryRun
    .then(() => runMemoryJudge({ service: memoryService, userInput, assistantReply: reply, provider }))
    .catch((err) => console.log('[memory-judge] auto extraction skipped:', err && err.message));
}

// ---------- 提醒 / 日程 ----------

ipcMain.handle('schedule:list', guarded('schedule:list', (filter) => schedulerService.list(filter)));

ipcMain.handle('schedule:create', guarded('schedule:create', (input) => schedulerService.create(input)));

ipcMain.handle('schedule:update', guarded('schedule:update', (id, patch) => schedulerService.update(id, patch)));

ipcMain.handle('schedule:remove', guarded('schedule:remove', (id) => schedulerService.remove(id)));

ipcMain.handle('schedule:clear', guarded('schedule:clear', () => {
  schedulerService.clearAll();
  return true;
}));

function deliverReminder(schedule) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('reminder:fire', { id: schedule.id, title: schedule.title, note: schedule.note });
}

function checkDueReminders() {
  if (!schedulerService || !proactiveSettingsStore || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  const due = schedulerService.due();
  for (const schedule of due) {
    const decision = reminderGate({ now: new Date(), proactiveSettings: proactiveSettingsStore.get() });
    if (!decision.deliver) continue;
    deliverReminder(schedule);
    schedulerService.advance(schedule);
  }
}

function stopReminderTimer() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}

ipcMain.handle('state:get', () => {
  return emotionService ? { ...emotionService.getState(), memoryCounts: memoryCounts() } : null;
});

ipcMain.handle('state:moodMap', () => MOOD_MAP);

ipcMain.handle('chat:llm', async (_e, input) => {
  const available = await generic.isAvailable();
  if (!available) {
    return {
      source: 'none',
      reply: null,
      mode: 'llm',
      error: `${generic.getActiveProvider().label} 不可用`,
    };
  }
  try {
    const reply = await generic.generateReply(input, {
      emotionState: emotionService ? emotionService.getState() : null,
    });
    return { source: 'llm', reply, mode: 'llm' };
  } catch (err) {
    return { source: 'none', reply: null, mode: 'llm', error: String(err.message || err) };
  }
});

// 初始化时发送屏幕工作区给渲染进程
ipcMain.handle('window:init', () => {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return workArea;
});

// 简单串行队列：保证连续发送的聊天按顺序处理，避免并发请求交错导致回复乱序
let chatQueue = Promise.resolve();

// 主人自报称呼 → 提取叫法（如「我叫小明 / 我的名字是/叫 / 请叫我/喊我/称呼我X」）
// 支持口语前缀（你好/以后/麻烦/要/我想）和末尾语气词（吧/啊/哦/哈）
function extractOwnerName(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;

  // 去掉开头寒暄/请求词与结尾语气词，聚焦称呼声明
  text = text.replace(/^(?:你好|嗨|哈喽|hello|hi|那个|嗯|就是|我要|我想|希望你|你以后|以后|请你|麻烦你|请|记得|记住|那|就|先)[，,、\s]*/i, '');
  text = text.replace(/[吧啊哦呢哈呀了好了就好就行嘛～~！!？?。，,、\s]+$/g, '');

  const NAME = '[^\\s，。！!？?,、]{1,12}';
  const nameClauses = [
    `我的名字(?:叫|是)?(${NAME})$`,
    `我名字(?:叫|是)?(${NAME})$`,
    `名字(?:叫|是)?(${NAME})$`,
    `叫我(${NAME})$`,
    `喊我(${NAME})$`,
    `称呼我(${NAME})$`,
    `我叫(${NAME})$`,
  ];
  for (const source of nameClauses) {
    const match = text.match(new RegExp(source));
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

function enqueueChat(fn) {
  const run = chatQueue.then(fn, fn);
  // 队列吞掉异常，避免断裂；异常已由 fn 内部处理
  chatQueue = run.catch(() => {});
  return run;
}

async function sendChat(input) {
  // 推入串行队列，严格按发送顺序执行
  return enqueueChat(() => sendChatInner(input));
}

async function sendChatInner(input) {
  if (emotionService) emotionService.recordInteraction(input);
  publishState();

  // 主人自报称呼：识别「我叫X/我的名字叫X/称呼我X」并把称呼存进 owner.json
  const ownerName = extractOwnerName(input);
  if (ownerName) {
    const previous = ownerStore.get().name;
    ownerStore.set({ name: ownerName });
    if (!previous || previous === ownerName) {
      return { source: 'rule', reply: `好呀，那我就叫你${ownerName}啦！以后要常来找我玩哦~` };
    }
    return { source: 'rule', reply: `唔？你以前不是${previous}嘛……好吧，那现在开始就叫你${ownerName}啦！` };
  }

  // 记忆意图既是命令，经记忆服务处理，不经过普通 LLM。
  const intent = parseMemoryIntent(input);
  if (intent.kind !== 'none') {
    const result = handleMemoryIntent(intent);
    if (result) return result;
  }

  // 按优先级依次尝试各 provider（自动回退链）
  const memoryContext = memoryContextFor(input);
  for (const name of generic.providerChain()) {
    try {
      const available = await generic.isAvailable(name);
      if (!available) continue;
      const reply = await generic.generateReply(input, {
        provider: name,
        emotionState: emotionService ? emotionService.getState() : null,
        memory: memoryContext,
        ownerName: ownerStore && ownerStore.get().name,
      });
      scheduleAutoMemory(input, reply, name);
      scheduleReflection(name);
      return { source: 'llm', reply, provider: name };
    } catch {
      /* 尝试下一个 */
    }
  }

  // 兜底
  return { source: 'fallback', reply: "唔……这个问题有点难住我了，主人教我一下好不好？" };
}

ipcMain.handle('chat:send', async (_e, input) => {
  return sendChat(input);
});

// 流式对话：生成过程中把增量块发给渲染进程，实现边说边显示
ipcMain.handle('chat:sendStream', async (e, input) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const emit = (chunk, full) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:delta', { chunk, full, done: false });
    }
  };
  const reply = await sendChatStream(input, emit);
  if (win && !win.isDestroyed()) {
    win.webContents.send('chat:delta', { chunk: '', full: reply, done: true });
  }
  return { source: 'llm', reply };
});

async function sendChatStream(input, emit) {
  if (emotionService) emotionService.recordInteraction(input);
  publishState();

  // 主人自报称呼：识别「我叫X/我的名字叫X/称呼我X」并把称呼存进 owner.json
  const ownerName = extractOwnerName(input);
  if (ownerName) {
    const previous = ownerStore.get().name;
    ownerStore.set({ name: ownerName });
    const reply = (!previous || previous === ownerName)
      ? `好呀，那我就叫你${ownerName}啦！以后要常来找我玩哦~`
      : `唔？你以前不是${previous}嘛……好吧，那现在开始就叫你${ownerName}啦！`;
    if (typeof emit === 'function') emit('', reply);
    return reply;
  }

  const intent = parseMemoryIntent(input);
  if (intent.kind !== 'none') {
    const result = handleMemoryIntent(intent);
    if (result) return result.reply;
  }

  const memoryContext = memoryContextFor(input);
  for (const name of generic.providerChain()) {
    try {
      const available = await generic.isAvailable(name);
      if (!available) continue;
      const reply = await generic.generateReply(input, {
        provider: name,
        emotionState: emotionService ? emotionService.getState() : null,
        memory: memoryContext,
        ownerName: ownerStore && ownerStore.get().name,
        onDelta: emit,
      });
      scheduleAutoMemory(input, reply, name);
      scheduleReflection(name);
      return reply;
    } catch {
      /* 尝试下一个 */
    }
  }

  // 兜底
  return "唔……这个问题有点难住我了，主人教我一下好不好？";
}

// 手动拖拽移动窗口（避免 -webkit-app-region 阻断点击）
// 使用 sender 对应的窗口，使主窗口与菜单窗口都能被拖拽移动。
ipcMain.on('window:moveBy', (e, dx, dy) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// 打开独立菜单窗口（无边框、透明、置顶，可全屏拖拽）
ipcMain.handle('menu:open', (_e, screenX, screenY) => {
  openMenuWindow();
  menuPendingPos = { x: screenX, y: screenY };
  return true;
});

// 菜单窗口就绪后，由菜单内容调用，把窗口定位到鼠标附近的屏幕坐标
ipcMain.handle('menu:ready', () => {
  if (menuWindow && !menuWindow.isDestroyed() && menuPendingPos) {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const [w, h] = menuWindow.getContentSize();
    const px = Math.max(wa.x, Math.min(menuPendingPos.x, wa.x + wa.width - w - 8));
    const py = Math.max(wa.y, Math.min(menuPendingPos.y, wa.y + wa.height - h - 8));
    menuWindow.setPosition(Math.round(px), Math.round(py));
  }
  return true;
});

ipcMain.handle('menu:close', () => {
  closeMenuWindow();
  return true;
});

// ---------- 独立对话输入窗口 ----------

// 打开对话输入窗口
ipcMain.handle('chat:openInput', () => {
  openChatInputWindow();
  return true;
});

// 关闭对话输入窗口
ipcMain.handle('chat:closeInput', () => {
  closeChatInputWindow();
  return true;
});

ipcMain.handle('chat:resizeInput', (e, requestedHeight) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return false;

  const height = Math.max(96, Math.min(220, Math.round(Number(requestedHeight) || 96)));
  const [width] = win.getContentSize();
  win.setContentSize(width, height);

  const [x, y] = win.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  const { workArea } = display;
  const nextY = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));
  if (nextY !== y) win.setPosition(x, nextY);
  chatInputLastPosition = { x, y: nextY };
  return true;
});

// 从输入窗口提交消息：保留输入窗口，在宠物主窗口播放流式回复。
// 进入 chatQueue 串行队列，避免与其它聊天并发导致历史/回复顺序错乱。
ipcMain.handle('chat:submit', async (_e, input) => {
  const text = String(input || '').trim();
  if (!text) return '';
  const emit = (chunk, full) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:delta', { chunk, full, done: false });
    }
  };
  const reply = await enqueueChat(() => sendChatStream(text, emit));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat:delta', { chunk: '', full: reply, done: true });
  }
  return reply;
});

// 「查看状态」：让主窗口显示情感状态面板
ipcMain.handle('menu:showState', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show:state');
  }
  closeMenuWindow();
  return true;
});

// Provider settings panel IPC
ipcMain.handle('provider:getConfig', () => {
  const config = generic.loadProviders();
  const activeName = generic.getActiveProviderName() || (config.activeProvider);
  return { ...config, _active: activeName };
});

ipcMain.handle('provider:saveConfig', (_e, raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return IPC_ERROR;
  generic.saveProviders(raw);
  return true;
});

ipcMain.handle('provider:checkProvider', (_e, providerData) => {
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return false;
  return generic.checkProviderConf(providerData);
});

ipcMain.handle('provider:openPanel', () => {
  openProviderPanel();
  return true;
});

ipcMain.handle('provider:closePanel', () => {
  closeProviderPanel();
  return true;
});

ipcMain.handle('settings:openPanel', () => {
  openSettingsPanel();
  return true;
});

ipcMain.handle('settings:closePanel', () => {
  closeSettingsPanel();
  return true;
});

// ── 记忆库面板（U3）──
let memoryPanelWindow = null;
function openMemoryPanel() {
  closeMemoryPanel();
  memoryPanelWindow = new BrowserWindow({
    width: 500,
    height: 680,
    transparent: false,
    frame: true,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  memoryPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  memoryPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'memory-panel.html'));
  memoryPanelWindow.on('closed', () => { memoryPanelWindow = null; });
}
function closeMemoryPanel() {
  if (memoryPanelWindow && !memoryPanelWindow.isDestroyed()) memoryPanelWindow.destroy();
  memoryPanelWindow = null;
}
ipcMain.handle('memory:openPanel', () => { openMemoryPanel(); return true; });

ipcMain.handle('schedule:openPanel', () => {
  openSchedulePanel();
  return true;
});

ipcMain.handle('schedule:closePanel', () => {
  closeSchedulePanel();
  return true;
});

function openSchedulePanel() {
  closeSchedulePanel();
  schedulePanelWindow = new BrowserWindow({
    width: 480,
    height: 640,
    transparent: false,
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  schedulePanelWindow.setAlwaysOnTop(true, 'screen-saver');
  schedulePanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'schedule-panel.html'));
  schedulePanelWindow.on('closed', () => {
    schedulePanelWindow = null;
  });
}

function closeSchedulePanel() {
  if (schedulePanelWindow && !schedulePanelWindow.isDestroyed()) {
    schedulePanelWindow.destroy();
  }
  schedulePanelWindow = null;
}

function openSettingsPanel() {
  closeSettingsPanel();
  settingsPanelWindow = new BrowserWindow({
    width: 460,
    height: 620,
    transparent: false,
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  settingsPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings-panel.html'));
  settingsPanelWindow.on('closed', () => {
    settingsPanelWindow = null;
  });
}

function closeSettingsPanel() {
  if (settingsPanelWindow && !settingsPanelWindow.isDestroyed()) {
    settingsPanelWindow.destroy();
  }
  settingsPanelWindow = null;
}

function openOwnerPanel() {
  closeOwnerPanel();
  ownerPanelWindow = new BrowserWindow({
    width: 460,
    height: 560,
    transparent: false,
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ownerPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  ownerPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'owner-panel.html'));
  ownerPanelWindow.on('closed', () => {
    ownerPanelWindow = null;
  });
}

function closeOwnerPanel() {
  if (ownerPanelWindow && !ownerPanelWindow.isDestroyed()) {
    ownerPanelWindow.destroy();
  }
  ownerPanelWindow = null;
}

function openPersonalityPanel() {
  closePersonalityPanel();
  personalityPanelWindow = new BrowserWindow({
    width: 520,
    height: 680,
    transparent: false,
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  personalityPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  personalityPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'personality-panel.html'));
  personalityPanelWindow.on('closed', () => {
    personalityPanelWindow = null;
  });
}

function closePersonalityPanel() {
  if (personalityPanelWindow && !personalityPanelWindow.isDestroyed()) {
    personalityPanelWindow.destroy();
  }
  personalityPanelWindow = null;
}

function openProviderPanel() {
  closeProviderPanel();
  providerPanelWindow = new BrowserWindow({
    width: 480,
    height: 600,
    transparent: false,
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  providerPanelWindow.setAlwaysOnTop(true, 'screen-saver');
  providerPanelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'provider-panel.html'));
  providerPanelWindow.on('closed', () => {
    providerPanelWindow = null;
  });
}

function closeProviderPanel() {
  if (providerPanelWindow && !providerPanelWindow.isDestroyed()) {
    providerPanelWindow.destroy();
  }
  providerPanelWindow = null;
}

// ---------- 独立对话输入窗口 ----------

function openChatInputWindow() {
  closeChatInputWindow();
  chatInputWindow = new BrowserWindow({
    width: 380,
    height: 112,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 不使用 screen-saver 层级，否则 macOS 输入法候选框会被输入窗口遮住。
  // floating 仍能保持输入框悬浮，但允许输入法候选窗口显示在上方。
  chatInputWindow.setAlwaysOnTop(true, 'floating');
  const mainBounds = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { x: screen.getCursorScreenPoint().x, y: screen.getCursorScreenPoint().y, width: 320, height: 360 };
  const display = screen.getDisplayNearestPoint({
    x: mainBounds.x + Math.round(mainBounds.width / 2),
    y: mainBounds.y + Math.round(mainBounds.height / 2),
  });
  const { workArea } = display;
  const [width, height] = chatInputWindow.getSize();
  const centeredX = mainBounds.x + Math.round((mainBounds.width - width) / 2);
  const candidates = [
    { x: centeredX, y: mainBounds.y + mainBounds.height + 10 },
    { x: centeredX, y: mainBounds.y - height - 10 },
    { x: mainBounds.x + mainBounds.width + 10, y: mainBounds.y + Math.round((mainBounds.height - height) / 2) },
    { x: mainBounds.x - width - 10, y: mainBounds.y + Math.round((mainBounds.height - height) / 2) },
  ];
  const fits = (pos) => (
    pos.x >= workArea.x + 8
    && pos.y >= workArea.y + 8
    && pos.x + width <= workArea.x + workArea.width - 8
    && pos.y + height <= workArea.y + workArea.height - 8
  );
  const selected = chatInputLastPosition && fits(chatInputLastPosition)
    ? chatInputLastPosition
    : candidates.find(fits) || {
    x: Math.max(workArea.x + 8, Math.min(centeredX, workArea.x + workArea.width - width - 8)),
    y: Math.max(workArea.y + 8, Math.min(mainBounds.y + mainBounds.height + 10, workArea.y + workArea.height - height - 8)),
  };
  chatInputLastPosition = { x: selected.x, y: selected.y };
  chatInputWindow.setPosition(Math.round(selected.x), Math.round(selected.y));
  chatInputWindow.loadFile(path.join(__dirname, '..', 'renderer', 'chat-input.html'));
  chatInputWindow.on('closed', () => {
    chatInputWindow = null;
  });
}

function closeChatInputWindow() {
  if (chatInputWindow && !chatInputWindow.isDestroyed()) {
    const [x, y] = chatInputWindow.getPosition();
    chatInputLastPosition = { x, y };
    chatInputWindow.destroy();
  }
  chatInputWindow = null;
}

function openMenuWindow() {
  closeMenuWindow();
  menuWindow = new BrowserWindow({
    width: 200,
    height: 320,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  menuWindow.setAlwaysOnTop(true, 'screen-saver');
  menuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'menu.html'));
  menuWindow.on('closed', () => {
    menuWindow = null;
  });
}

function closeMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.destroy();
  }
  menuWindow = null;
}

app.whenReady().then(() => {
  emotionService = createEmotionService(path.join(app.getPath('userData'), 'emotion-state.json'));
  proactiveSettingsStore = createProactiveSettingsStore({
    filePath: path.join(app.getPath('userData'), 'proactive-settings.json'),
  });
  proactivePolicy = createProactivePolicy({ getSettings: () => proactiveSettingsStore.get() });
  memoryService = createMemoryService(createMemoryStore({
    filePath: path.join(app.getPath('userData'), 'memory.json'),
  }));
  settingsStore = createSettingsStore({
    filePath: path.join(app.getPath('userData'), 'settings.json'),
  });
  ownerStore = createOwnerStore({
    filePath: path.join(app.getPath('userData'), 'owner.json'),
  });
  personalityRuntime.setRuntimePath(path.join(app.getPath('userData'), 'personality-runtime.json'));
  schedulerService = createSchedulerService(createJsonStorage({
    filePath: path.join(app.getPath('userData'), 'schedules.json'),
    schemaVersion: 1,
    defaults: { schedules: [] },
  }));
  reminderTimer = setInterval(checkDueReminders, 30000);
  recordEmotionEvent('APP_STARTED', { moodScore: 1, energy: -1 });
  createWindow();
  registerShowShortcut();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 桌宠常驻：关闭窗口不退出，由托盘控制
  app.quit();
});

app.on('quit', () => {
  stopReminderTimer();
  unregisterShowShortcut();
});
