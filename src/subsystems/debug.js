// 运行期调试记录：仅暴露通用 LLM 调用器已经脱敏后的内存快照。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, generic, panels }) {
  ipcMain.handle(IPC.DebugGetEntries, () => generic.getDebugEntries());
  ipcMain.handle(IPC.DebugClearEntries, () => generic.clearDebugEntries());
  ipcMain.handle(IPC.DebugOpenPanel, () => { panels.openDebugPanel(); return true; });
  ipcMain.handle(IPC.DebugClosePanel, () => { panels.closeDebugPanel(); return true; });
};
