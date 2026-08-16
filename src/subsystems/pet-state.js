// pet 状态子系统（P0-5）：把 pet-state 暴露给渲染层，供面板显示好感/等级/阶段。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, petState }) {
  ipcMain.handle(IPC.PetStateGet, () => petState.getState());
};
