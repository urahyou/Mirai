// 模型/Provider 子系统（L3）：provider 配置读写/连通性探测 + 面板 IPC。
// 保存 provider 后重新探测模型上下文上限（chat.refreshModelMaxTokens）。
const IPC = require('../contracts/ipc');

module.exports = function setup({ ipcMain, generic, chat, panels }) {
  ipcMain.handle(IPC.ProviderGetConfig, () => generic.getProviderConfig());
  ipcMain.handle(IPC.ProviderSaveConfig, (_event, config) => {
    try {
      const result = { ok: true, config: generic.saveProviderConfig(config) };
      // provider 变化后重新探测模型上下文上限
      void chat.refreshModelMaxTokens();
      return result;
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });
  ipcMain.handle(IPC.ProviderCheck, (_event, provider) => generic.checkProvider(provider));
  ipcMain.handle(IPC.ProviderOpenPanel, () => { panels.openProviderPanel(); return true; });
  ipcMain.handle(IPC.ProviderClosePanel, () => { panels.closeProviderPanel(); return true; });
};
