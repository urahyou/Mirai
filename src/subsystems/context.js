// 上下文预算子系统（L3）：探测模型最大上下文 + 滑条控制 token 预算 + 面板 IPC。
// guard 上限跟随探测到的模型上下文（contextSettings.getUpperBound），不硬编码 128k，
// 否则探测出更大模型时滑条“拉不动”（见 100cff9 修复）。
const IPC = require('../contracts/ipc');
const { validatePayload, IPC_ERROR } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, contextSettings, chat, panels, state }) {
  ipcMain.handle(IPC.ContextGet, async () => {
    const settings = contextSettings.getSettings(state.cachedModelMaxTokens);
    return { ...settings, modelMaxTokens: state.cachedModelMaxTokens };
  });
  ipcMain.handle(IPC.ContextSet, (event, ...args) => {
    // guard 上限跟随探测到的模型上下文（而不是硬编码 128k），否则探测出更大模型时拉不动滑条
    const result = validatePayload(IPC.ContextSet, args, { contextMaxTokens: contextSettings.getUpperBound(state.cachedModelMaxTokens) });
    return result.ok ? contextSettings.setSettings(result.data[0], state.cachedModelMaxTokens) : IPC_ERROR;
  });
  ipcMain.handle(IPC.ContextProbe, async () => {
    await chat.refreshModelMaxTokens();
    return state.cachedModelMaxTokens;
  });
  ipcMain.handle(IPC.ContextOpenPanel, () => { panels.openContextPanel(); return true; });
  ipcMain.handle(IPC.ContextClosePanel, () => { panels.closeContextPanel(); return true; });
};
