const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, perceptionManager }) {
  if (!perceptionManager) return;
  ipcMain.handle(IPC.PerceptionList, () => perceptionManager.list());
  ipcMain.handle(IPC.PerceptionSet, guarded(IPC.PerceptionSet, (id, patch) => perceptionManager.set(id, patch)));
  ipcMain.handle(IPC.PerceptionClear, guarded(IPC.PerceptionClear, (id) => perceptionManager.clear(id)));
};
