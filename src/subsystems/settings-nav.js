// 设置中心导航子系统（2026-08）。
//
// 把"设置中心首页"与各子面板（与小未来相处/外观/桌面行为，以及已有的
// 聊天·上下文/记忆/性格/语音/模型）的开合 IPC 集中在这里接线。
// 保持 main.js 纯装配；子面板"返回设置中心"也经此通道。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, panels }) {
  // 设置中心首页
  ipcMain.handle(IPC.SettingsCenterOpen, () => { panels.openSettingsCenterPanel(); return true; });
  ipcMain.handle(IPC.SettingsCenterClose, () => { panels.closeSettingsCenterPanel(); return true; });

  // 外观（大小/阴影/气泡）
  ipcMain.handle(IPC.AppearanceOpen, () => { panels.openAppearancePanel(); return true; });
  ipcMain.handle(IPC.AppearanceClose, () => { panels.closeAppearancePanel(); return true; });

  // 桌面行为（置顶/扇形）
  ipcMain.handle(IPC.BehaviorOpen, () => { panels.openBehaviorPanel(); return true; });
  ipcMain.handle(IPC.BehaviorClose, () => { panels.closeBehaviorPanel(); return true; });

  // 与小未来相处（状态/感知/日记/喂养）
  ipcMain.handle(IPC.CompanionOpen, () => { panels.openCompanionPanel(); return true; });
  ipcMain.handle(IPC.CompanionClose, () => { panels.closeCompanionPanel(); return true; });
};
