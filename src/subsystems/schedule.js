// 日程提醒子系统（P1）：把 schedule（读本地 .ics）的 remind 行动接起来
// （voice.speak 朗读 + 向宠物主窗发 ChatDelta 显示气泡，不入正式多轮历史），
// 与 proactive 的 say 通道同构。不注册任何 ipcMain 处理器。
const scheduleSys = require('../systems/schedule');
const IPC = require('../contracts/ipc');
const fs = require('fs');
const path = require('path');

module.exports = function setup({ voice, state, storage, app }) {
  if (!voice || !state) return;

  // 用户可放置 userData/schedule.ics；缺省则静默关闭（schedule 内部不触发）。
  const icsFile = path.join(app.getPath('userData'), 'schedule.ics');
  const readIcs = () => { try { return fs.readFileSync(icsFile, 'utf8'); } catch { return ''; } };

  scheduleSys.init({
    storage,
    ics: readIcs,
    onEmit: (line) => {
      if (!line) return;
      try { voice.speak(String(line)); } catch {}
      try {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send(IPC.ChatDelta, {
            chunk: line, full: line, done: true, turnId: `schedule-${Date.now()}`,
          });
        }
      } catch {}
    },
  });
  scheduleSys.start();
  // 供 will-quit 停止
  return { stop: () => scheduleSys.stop() };
};
