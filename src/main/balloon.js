// 独立气泡窗口模块：气泡窗的创建、定位（贴头顶/拖离后随人物）、渲染调度与隐藏。
//
// 通过依赖注入获得所需能力：
//   - state：共享窗口引用与气泡状态（唯一事实源）
//   - windowOptions()：统一定制 BrowserWindow 的 webPreferences
//   - config.dev：开发模式控制台日志
// 气泡的 IPC 指令（balloon:show/update/finish/hide、balloonWindow:dragMove 等）
// 仍由主进程注册，这里只提供这些指令背后的实现函数。
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const IPC = require('../contracts/ipc');

const BALLOON_WINDOW_SIZE = { width: 320, height: 200 };
const BALLOON_HEAD_ANCHOR_RATIO = 0.24; // 头顶锚点：主窗顶部向下的比例
const BALLOON_WORK_AREA_MARGIN = 8;

module.exports = function createBalloons({ state, windowOptions, config }) {
  function createBalloonWindow() {
    if (state.balloonWindow && !state.balloonWindow.isDestroyed()) return;
    state.balloonWindow = new BrowserWindow({
      width: BALLOON_WINDOW_SIZE.width,
      height: BALLOON_WINDOW_SIZE.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      // 需可聚焦，否则无法用鼠标选中文字复制；不会进任务栏（skipTaskbar）。
      focusable: true,
      webPreferences: windowOptions(),
    });
    state.balloonWindow.setAlwaysOnTop(true, 'screen-saver');
    if (typeof state.balloonWindow.setVisibleOnAllWorkspaces === 'function') {
      state.balloonWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    state.balloonWindow.loadFile(path.join(__dirname, '..', 'renderer', 'balloon.html'));
    if (config.dev) {
      state.balloonWindow.webContents.on('console-message', (_event, _level, message) => console.log('[balloon-r]', message));
    }
    // 注意：首条渲染指令不在此处（did-finish-load）发送——此时 renderer 的 onRender
    // 可能还没注册好（balloon.js 用轮询等 DOM），did-finish-load 就发会导致丢失。
    // 改为由 renderer 上报 balloon:ready 后再 flush（见 ipcMain.handle(IPC.BalloonReady)）。
    state.balloonWindow.on('closed', () => { state.balloonWindow = null; state.pendingBalloonRender = null; });
  }

  // 气泡锚点：默认贴着角色头顶（主窗水平居中、顶部向下取一个比例）
  function balloonAnchorPoint() {
    const mainBounds = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow.getBounds() : null;
    const cursor = screen.getCursorScreenPoint();
    return mainBounds
      ? { x: mainBounds.x + mainBounds.width / 2, y: mainBounds.y + mainBounds.height * BALLOON_HEAD_ANCHOR_RATIO }
      : { x: cursor.x, y: cursor.y };
  }

  function clampToWorkArea(p, width, height) {
    const { workArea } = screen.getDisplayNearestPoint(p);
    return {
      x: Math.max(workArea.x + BALLOON_WORK_AREA_MARGIN, Math.min(p.x, workArea.x + workArea.width - width - BALLOON_WORK_AREA_MARGIN)),
      y: Math.max(workArea.y + BALLOON_WORK_AREA_MARGIN, Math.min(p.y, workArea.y + workArea.height - height - BALLOON_WORK_AREA_MARGIN)),
    };
  }

  function positionBalloon() {
    if (!state.balloonWindow || state.balloonWindow.isDestroyed() || !state.balloonVisible) return;
    const [width, height] = state.balloonWindow.getSize();
    const anchor = balloonAnchorPoint();
    let position;
    if (state.balloonFreed && state.balloonRelToMain && state.mainWindow && !state.mainWindow.isDestroyed()) {
      // 用户拖走过气泡：保持其相对人物的屏幕偏移，人物移动时气泡跟着一起动
      const main = state.mainWindow.getBounds();
      position = { x: main.x + state.balloonRelToMain.x, y: main.y + state.balloonRelToMain.y };
    } else {
      // 默认贴着角色头顶
      position = { x: anchor.x - width / 2, y: anchor.y - height / 2 };
    }
    const pos = clampToWorkArea(position, width, height);
    // Electron 的原生窗口位置要求整数；居中计算和缩放后尺寸可能产生浮点数。
    state.balloonWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
  }

  // 把渲染指令发给气泡窗口。若页面还在加载（首次创建时），先缓存、
  // 等 did-finish-load 后 flush，避免首条消息在 load 完成前丢失。
  function dispatchBalloonRender(payload) {
    if (!state.balloonWindow || state.balloonWindow.isDestroyed()) return;
    if (state.balloonWindow.webContents.isLoading()) {
      state.pendingBalloonRender = payload;
      return;
    }
    state.balloonWindow.webContents.send(IPC.BalloonRender, payload);
    state.pendingBalloonRender = null;
  }

  function balloonRender(payload) {
    createBalloonWindow();
    if (!state.balloonWindow || state.balloonWindow.isDestroyed()) return;
    clearTimeout(state.balloonHideTimer);
    state.balloonVisible = true;
    positionBalloon();
    dispatchBalloonRender(payload);
    state.balloonWindow.show();
    state.balloonWindow.moveTop();
  }

  function balloonHide() {
    if (!state.balloonWindow || state.balloonWindow.isDestroyed()) return;
    state.balloonVisible = false;
    clearTimeout(state.balloonHideTimer);
    dispatchBalloonRender({ action: 'hide' });
    state.balloonHideTimer = setTimeout(() => {
      if (state.balloonWindow && !state.balloonWindow.isDestroyed()) state.balloonWindow.hide();
    }, 320); // 等淡出动画结束再真正隐藏窗口，避免闪烁
  }

  return {
    createBalloonWindow,
    balloonRender,
    balloonHide,
    positionBalloon,
    dispatchBalloonRender,
    clampToWorkArea,
  };
};
