// 日记 & 系统感知 可见性子系统（P1）。
//
// 让控制面板能看到/操作此前"后台不可见"的功能：
// - diary:getToday    读今天的自写日记（journals/YYYY-MM-DD.md），无则返回 exists:false
// - diary:listDates   列出已有日记日期（供面板看历史）
// - diary:openFolder  用系统文件管理器打开 journals 目录
// - systemSense:get   实时系统感知（此刻/电量/联网）
//
// 纯读取，不写任何文件；渲染层仅经 preload 调用。

const IPC = require('../contracts/ipc');
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

function p2(n) { return String(n).padStart(2, '0'); }
function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function jdir(userData) { return path.join(userData, 'journals'); }

module.exports = function setup({ ipcMain, app, systemSense }) {
  const dir = () => jdir(app.getPath('userData'));

  ipcMain.handle(IPC.DiaryGetToday, () => {
    try {
      const date = todayLocal();
      const fp = path.join(dir(), `${date}.md`);
      const exists = fs.existsSync(fp);
      return { date, exists, content: exists ? fs.readFileSync(fp, 'utf8') : '' };
    } catch (e) { return { date: todayLocal(), exists: false, content: '', error: String(e && e.message) }; }
  });

  ipcMain.handle(IPC.DiaryOpenFolder, () => {
    try { return shell.openPath(dir()); } catch (e) { return String(e && e.message) || 'error'; }
  });

  ipcMain.handle(IPC.SystemSenseGet, () => {
    let awareness = '', snapshot = null;
    try { awareness = systemSense.getAwareness(); snapshot = systemSense.getSnapshot(); } catch {}
    return { awareness, snapshot };
  });
};
