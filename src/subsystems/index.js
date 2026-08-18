// 主进程 IPC 子系统装配器（L3）。
//
// 每个能力域各自 require '../contracts/ipc' 与 '../main/ipc-validation'（纯工具），
// 其余的运行时依赖（ipcMain / windows / panels / voice / chat / balloons / services 等）
// 全部由 main.js 构造的单一 api 胶囊注入，子系统内部不互相 require、不产生循环依赖。
//
// 新增能力 = 在 src/subsystems/ 加一个 setup(api) 并在本文件注册一行即可（插件化落点）。
const personality = require('./personality');
const display = require('./display');
const voice = require('./voice');
const provider = require('./provider');
const context = require('./context');
const memory = require('./memory');
const balloon = require('./balloon');
const windowCtl = require('./window');
const menu = require('./menu');
const petState = require('./pet-state');
const proactive = require('./proactive');
const perception = require('./perception');
const schedule = require('./schedule');
const diary = require('./diary');
const settingsNav = require('./settings-nav');
const debug = require('./debug');
const agent = require('./agent');

module.exports = function mountAll(api) {
  personality(api);
  display(api);
  voice(api);
  provider(api);
  context(api);
  memory(api);
  balloon(api);
  windowCtl(api);
  menu(api);
  petState(api);
  proactive(api);
  perception(api);
  schedule(api);
  diary(api);
  settingsNav(api);
  debug(api);
  agent(api);
};
