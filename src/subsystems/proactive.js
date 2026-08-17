// 主动关怀子系统（P1 起步）：把 pet-state / sensing 的事件接到「决策→行动」，
// 让 小未来 在冷落/深夜/连用/晋升时主动开口（朗读 + 宠物窗气泡，不入正式多轮历史）。
//
// 纯决策引擎在 src/systems/proactive.js；这里只负责把决策的 say() 行动接起来
// （voice.speak 朗读 + 向宠物主窗发 ChatDelta 显示气泡）。不注册任何 ipcMain 处理器。
const proactiveSys = require('../systems/proactive');
const IPC = require('../contracts/ipc');

module.exports = function setup({ voice, state, eventBus, initiativeSettings, ipcMain }) {
  if (!eventBus) return;
  proactiveSys.init({
    eventBus,
    initiativePolicy: initiativeSettings,
    say: (line) => {
      if (!line) return;
      try { voice.speak(String(line)); } catch {}
      try {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send(IPC.ChatDelta, {
            chunk: line, full: line, done: true, turnId: `proactive-${Date.now()}`,
          });
        }
      } catch {}
    },
  });
  if (initiativeSettings && ipcMain) {
    ipcMain.handle(IPC.InitiativeGet, () => initiativeSettings.getSettings());
    ipcMain.handle(IPC.InitiativeSet, (_event, patch) => initiativeSettings.setSettings(patch));
  }
};
