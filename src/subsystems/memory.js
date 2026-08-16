// 长期记忆子系统（L3）：Graphiti 记忆状态/设置读写/回写 + 面板 IPC。
// （Graphiti 不可用时 getStatus 上报降级，add/search 由 chat.js 注入调用）
const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, graphitiMemory, panels }) {
  ipcMain.handle(IPC.MemoryGetStatus, async () => graphitiMemory.getStatus());
  ipcMain.handle(IPC.MemoryGetSettings, () => graphitiMemory.getSettingsForPanel());
  ipcMain.handle(IPC.MemorySetSettings, guarded(IPC.MemorySetSettings, (patch) => graphitiMemory.writeSettings(patch)));
  ipcMain.handle(IPC.MemoryOpenPanel, () => { panels.openMemoryPanel(); return true; });
  ipcMain.handle(IPC.MemoryClosePanel, () => { panels.closeMemoryPanel(); return true; });
};
