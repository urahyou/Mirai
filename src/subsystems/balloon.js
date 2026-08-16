// 气泡窗子系统（L3）：独立气泡窗的渲染/隐藏/就绪刷新，以及拖拽释放/重新锚定 IPC。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, balloons, state }) {
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
};
