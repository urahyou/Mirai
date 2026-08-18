const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, perceptionManager, weatherSettings, weatherSense }) {
  if (!perceptionManager) return;
  ipcMain.handle(IPC.PerceptionList, () => perceptionManager.list());
  ipcMain.handle(IPC.PerceptionSet, guarded(IPC.PerceptionSet, (id, patch) => perceptionManager.set(id, patch)));
  ipcMain.handle(IPC.PerceptionClear, guarded(IPC.PerceptionClear, (id) => perceptionManager.clear(id)));
  if (weatherSettings && weatherSense) {
    ipcMain.handle(IPC.WeatherGet, () => weatherSettings.getSettings());
    ipcMain.handle(IPC.WeatherSet, guarded(IPC.WeatherSet, (patch) => {
      const saved = weatherSettings.setSettings(patch);
      weatherSense.refresh();
      return saved;
    }));
  }
};
