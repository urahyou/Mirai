// 窗口辅助模块（L0 拆分）：主窗(桌宠)、聊天输入窗的创建/定位/置顶/显示应用，
// 以及 sendToChatInput 转发。全部通过依赖注入的 createWindows 工厂获得所需能力。
//
// 依赖：state（共享窗口引用/标志）、balloons（主窗移动/缩放时让气泡跟随）、
//   displaySettings / windowLayout（显示与窗口布局服务）、config.dev、
//   WINDOW 与 CHAT_INPUT_* 尺寸常量。
// windowOptions 是纯函数、模块级导出，供 panel.js / balloon.js 复用统一定制 webPreferences。
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const IPC = require('../contracts/ipc');

// 统一定制 BrowserWindow 的 webPreferences（contextIsolation 开启、禁 node、挂 preload）
function windowOptions(overrides = {}) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, 'preload.js'),
    ...overrides,
  };
}

module.exports = function createWindows({
  state, balloons, displaySettings, windowLayout, config,
  WINDOW, CHAT_INPUT_COMPACT_SIZE, CHAT_INPUT_EXPANDED_SIZE,
  CHAT_INPUT_BELLY_CENTER_RATIO, WORK_AREA_MARGIN,
}) {
  // 把桌宠定位到光标所在屏幕的右下角（首次启动/无保存位置时兜底）
  function placeAtBottomRight() {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(cursor);
    const [width, height] = state.mainWindow.getSize();
    state.mainWindow.setPosition(workArea.x + workArea.width - width - 20, workArea.y + workArea.height - height - 20);
  }

  // 从持久化布局恢复角色主窗位置。返回 true 表示已恢复，false 表示无保存位置或已不在任何屏幕内（需回退右下角）。
  function restoreMainWindowPosition() {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return false;
    const pos = windowLayout.getLayout().mainPosition;
    if (!pos) return false;
    const b = state.mainWindow.getBounds();
    // 屏幕配置可能变化（外接屏拔出/分辨率改变）：仅当保存位置仍与任一工作区有交集才恢复。
    const valid = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return pos.x < a.x + a.width && pos.x + b.width > a.x && pos.y < a.y + a.height && pos.y + b.height > a.y;
    });
    if (!valid) return false;
    state.mainWindow.setPosition(pos.x, pos.y);
    return true;
  }

  // 把角色主窗当前位置写入持久化布局（跨重启记忆）。
  function saveMainWindowPosition() {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    const b = state.mainWindow.getBounds();
    windowLayout.setLayout({ mainPosition: { x: b.x, y: b.y } });
  }

  // 角色窗口置顶层级策略（macOS 层级从高到低：screen-saver > floating > normal）：
  //  - 无对话框：置顶配置开 → screen-saver（高于一切）；关 → normal。
  //  - 紧凑对话框开启：置顶配置开 → floating（仍高于普通应用如微信，但低于对话框），
  //    关 → normal。这样达成“输入框 > 人物 > 微信”。
  //  - 展开对话框开启：人物保持 floating（始终置顶于普通应用），
  //    聊天窗本身转 normal（可被其他应用覆盖、当普通窗口用）。
  function setMainWindowAlwaysOnTop(enabled) {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
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
      state.mainWindow.webContents.send(IPC.DisplayChanged, settings);
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
    // 优先恢复上次保存的位置；首次启动或位置已不在屏幕上时，回退到光标所在屏右下角
    if (!restoreMainWindowPosition()) placeAtBottomRight();

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
    saveMainWindowPosition(); // 角色主窗位置跨重启记忆
    balloons.positionBalloon(); // 未拖离的贴头顶、已拖离的按相对偏移跟随
    syncChatInputWithMain();
  }

  function saveChatInputPosition(window) {
    if (!window || window.isDestroyed() || !state.mainWindow || state.mainWindow.isDestroyed()) return;
    const chatBounds = window.getBounds();
    const mainBounds = state.mainWindow.getBounds();
    windowLayout.setLayout({
      chatOffset: { x: chatBounds.x - mainBounds.x, y: chatBounds.y - mainBounds.y },
    });
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

  // 把渲染命令推给聊天输入窗（纯转发；channel 由调用方给定）
  function sendToChatInput(channel, data) {
    if (state.chatInputWindow && !state.chatInputWindow.isDestroyed()) {
      state.chatInputWindow.webContents.send(channel, data);
    }
  }

  return {
    windowOptions,
    placeAtBottomRight,
    restoreMainWindowPosition,
    saveMainWindowPosition,
    setMainWindowAlwaysOnTop,
    applyDisplaySettings,
    createMainWindow,
    syncChatInputWithMain,
    onMainWindowMoved,
    closeChatInputWindow,
    saveChatInputPosition,
    openChatInputWindow,
    resizeChatInputWindow,
    sendToChatInput,
  };
};

module.exports.windowOptions = windowOptions;
