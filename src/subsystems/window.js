// 窗口控制子系统（L3）：桌宠窗拖拽（增量/绝对定位）、拖拽置顶层级、鼠标穿透 IPC。
// 移动主窗后统一走 windows.onMainWindowMoved（气泡跟随 + 聊天窗相对跟随）。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, BrowserWindow, state, windows, displaySettings }) {
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
};
