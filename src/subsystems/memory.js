// 本地长期记忆子系统：只展示 Python Core SQLite 状态和面板入口。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, companionMemory, panels }) {
  ipcMain.handle(IPC.MemoryGetStatus, async () => companionMemory.getStatus());
  ipcMain.handle(IPC.MemoryOpenPanel, () => { panels.openMemoryPanel(); return true; });
  ipcMain.handle(IPC.MemoryClosePanel, () => { panels.closeMemoryPanel(); return true; });
};
