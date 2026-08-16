// 显示子系统（L3）：显示设置（大小/置顶/阴影）读写 + 面板 IPC。
// 保存/预览生效走 windows.applyDisplaySettings（主窗缩放 + 置顶层级 + 气泡跟随）。
const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, displaySettings, windows, panels }) {
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
};
