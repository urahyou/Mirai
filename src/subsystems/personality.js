// 性格子系统（L3）：性格读写/重置 + 性格设置面板 IPC。
const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, personalityRuntime, personalityConfig, generic, panels }) {
  ipcMain.handle(IPC.PersonalityGet, () => personalityRuntime.getPersonality());
  ipcMain.handle(IPC.PersonalitySet, guarded(IPC.PersonalitySet, (patch) => {
    const next = personalityRuntime.setPersonality(patch);
    personalityConfig.resetConfig();
    generic.resetConversationHistory();
    return next;
  }));
  ipcMain.handle(IPC.PersonalityReset, () => {
    const next = personalityRuntime.resetPersonality();
    personalityConfig.resetConfig();
    generic.resetConversationHistory();
    return next;
  });
  ipcMain.handle(IPC.PersonalityOpenPanel, () => { panels.openPersonalityPanel(); return true; });
  ipcMain.handle(IPC.PersonalityClosePanel, () => { panels.closePersonalityPanel(); return true; });
};
