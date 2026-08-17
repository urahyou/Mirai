// 本地长期记忆子系统：只展示 Python Core SQLite 状态和面板入口。
const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, companionMemory, panels }) {
  ipcMain.handle(IPC.MemoryGetStatus, async () => companionMemory.getStatus());
  ipcMain.handle(IPC.MemoryList, guarded(IPC.MemoryList, async (kind) => companionMemory.list(kind)));
  ipcMain.handle(IPC.MemoryGetGraph, async () => companionMemory.getGraph());
  ipcMain.handle(IPC.MemoryListMind, guarded(IPC.MemoryListMind, async (kind) => companionMemory.listMind(kind)));
  ipcMain.handle(IPC.MemoryListDailyJournals, async () => companionMemory.listDailyJournals());
  ipcMain.handle(IPC.MemoryGetDailyJournal, guarded(IPC.MemoryGetDailyJournal, async (day) => companionMemory.getDailyJournal(day)));
  ipcMain.handle(IPC.MemoryOpenPanel, () => { panels.openMemoryPanel(); return true; });
  ipcMain.handle(IPC.MemoryClosePanel, () => { panels.closeMemoryPanel(); return true; });
};
