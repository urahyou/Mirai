// 右键菜单子系统（L3）：自定义右键菜单（打开/重定位/关闭）+ 退出。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, panels, app }) {
  ipcMain.handle(IPC.MenuOpen, (_event, x, y) => {
    panels.openMenuWindow({ x: Number(x) || 0, y: Number(y) || 0 });
    return true;
  });
  ipcMain.handle(IPC.MenuReady, () => panels.repositionMenu());
  ipcMain.handle(IPC.MenuClose, () => { panels.closeMenuWindow(); return true; });
  // 统一处理一条用户发言（文本输入或语音识别结果都走这里）：记录历史→流式生成→写回
  ipcMain.handle(IPC.MenuQuit, () => { app.quit(); return true; });
};
