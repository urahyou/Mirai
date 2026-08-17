// 日记 & 系统感知 可见性子系统（P1）。
//
// 让控制面板能查看并按需生成日记。Python Core 的 SQLite 是正文和来源的唯一事实源；
// Markdown 只是供用户查看的导出副本，绝不反向作为记忆输入。
// - systemSense:get   实时系统感知（此刻/电量/联网）
//
// 仅在用户显式请求时写入 Core 和 Markdown 导出；渲染层仅经 preload 调用。

const IPC = require('../contracts/ipc');
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

function p2(n) { return String(n).padStart(2, '0'); }
function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function jdir(userData) { return path.join(userData, 'journals'); }

module.exports = function setup({ ipcMain, app, systemSense, companionMemory, generic }) {
  const dir = () => jdir(app.getPath('userData'));
  const generating = new Map();

  function exportMarkdown(date, prose) {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${date}.md`), `# 小未来日记 · ${date}\n\n${prose.trim()}\n`, 'utf8');
  }

  async function getCoreJournal(date) {
    try { return await companionMemory.getDailyJournal(date); } catch { return null; }
  }

  ipcMain.handle(IPC.DiaryGetToday, async () => {
    try {
      const date = todayLocal();
      const journal = await getCoreJournal(date);
      if (journal) return {
        date,
        exists: Boolean(journal.prose),
        content: journal.prose || '',
        sourceCount: Array.isArray(journal.sourceIds) ? journal.sourceIds.length : 0,
      };
      // Core 暂不可用时保留历史导出可读；不会把 Markdown 重新写回记忆。
      const fp = path.join(dir(), `${date}.md`);
      const exists = fs.existsSync(fp);
      return { date, exists, content: exists ? fs.readFileSync(fp, 'utf8') : '' };
    } catch (e) { return { date: todayLocal(), exists: false, content: '', error: String(e && e.message) }; }
  });

  ipcMain.handle(IPC.DiaryGenerateToday, async () => {
    const date = todayLocal();
    if (generating.has(date)) return generating.get(date);
    const task = (async () => {
      try {
        const material = await companionMemory.buildDailyJournal(date, -new Date().getTimezoneOffset());
        if (!material) throw new Error('本地记忆 Core 尚未就绪');
        const prose = await generic.generateDiary(material);
        const journal = await companionMemory.saveDailyJournal(date, prose);
        if (!journal?.prose) throw new Error('日记没有保存成功');
        exportMarkdown(date, journal.prose);
        return { ok: true, date, content: journal.prose, sourceCount: Array.isArray(journal.sourceIds) ? journal.sourceIds.length : 0 };
      } catch (error) {
        console.warn('[diary] generate failed:', error.message);
        return { ok: false, date, error: '日记暂时没有写出来，请检查当前模型连接后重试。' };
      } finally {
        generating.delete(date);
      }
    })();
    generating.set(date, task);
    return task;
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
