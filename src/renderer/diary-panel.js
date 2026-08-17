const $ = (id) => document.getElementById(id);
const weekday = ['日', '一', '二', '三', '四', '五', '六'];
let diaryRows = [];

function renderList() {
  const list = $('diaryList'); list.replaceChildren();
  const written = diaryRows.filter((item) => item.exists);
  $('diaryCount').textContent = `${written.length} 页`;
  if (!diaryRows.length) { list.textContent = '还没有可翻阅的日记。写下第一页后，它会留在这里。'; return; }
  diaryRows.forEach((item, index) => {
    const date = new Date(`${item.date}T12:00:00`); const button = document.createElement('button'); button.type = 'button'; button.className = `entry-item ${index === 0 ? 'active' : ''} ${item.exists ? '' : 'draft'}`;
    const day = document.createElement('span'); day.className = 'entry-day'; day.textContent = date.getDate();
    const copy = document.createElement('span'); copy.className = 'entry-copy'; const month = document.createElement('strong'); month.textContent = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`; const excerpt = document.createElement('small'); excerpt.textContent = item.exists ? item.excerpt || '这一天的日记' : '素材已整理，尚未写成日记'; copy.append(month, excerpt); button.append(day, copy);
    button.addEventListener('click', () => { list.querySelectorAll('.entry-item').forEach((node) => node.classList.remove('active')); button.classList.add('active'); loadPage(item); }); list.append(button);
  });
}
async function loadPage(item) {
  const date = new Date(`${item.date}T12:00:00`); $('diaryDate').textContent = `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`; $('diaryWeekday').textContent = `星期${weekday[date.getDay()]} · 小未来的记录`; $('diaryStamp').textContent = item.exists ? 'MY DIARY' : 'DRAFT PAGE'; $('diaryProse').textContent = '正在翻到这一页…';
  try { const journal = await window.desktopPet.diary.get(item.date); if (journal?.prose) { $('diaryProse').textContent = journal.prose.trim(); $('diarySources').textContent = `这一页来自 ${Array.isArray(journal.sourceIds) ? journal.sourceIds.length : item.sourceCount || 0} 条已保存素材`; } else { $('diaryProse').textContent = '这一天的素材已经整理好了，但小未来还没有把它写成日记。'; $('diarySources').textContent = '日记正文会在明确生成后保存。'; } } catch { $('diaryProse').textContent = '这一页暂时打不开，请刷新后再试。'; $('diarySources').textContent = ''; }
}
async function refresh() {
  try { const status = await window.desktopPet.memory.getStatus(); $('statusBox').className = `core-status ${status?.ok ? 'ok' : 'bad'}`; $('statusBox').textContent = status?.ok ? 'SQLite 已就绪' : 'Core 未就绪'; if (!status?.ok) { diaryRows = []; renderList(); $('diaryProse').textContent = '本地记忆 Core 尚未就绪，日记册暂时不可读取。'; return; } diaryRows = await window.desktopPet.diary.list(); renderList(); if (diaryRows.length) await loadPage(diaryRows[0]); else { $('diaryDate').textContent = '还没有日记页'; $('diaryStamp').textContent = 'MY DIARY'; $('diaryProse').textContent = '今天还没有日记。和小未来多相处一会儿，等她想写的时候，第一篇会出现在这里。'; } } catch (error) { $('statusBox').className = 'core-status bad'; $('statusBox').textContent = `读取失败：${error.message || error}`; }
}
$('refreshBtn').addEventListener('click', refresh); $('folderBtn').addEventListener('click', () => window.desktopPet.diary.openFolder()); $('closeBtn').addEventListener('click', () => window.desktopPet.diary.closePanel()); refresh();
