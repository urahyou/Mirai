const $ = (id) => document.getElementById(id);
const weekday = ['日', '一', '二', '三', '四', '五', '六'];
let activeKind = 'episodes';
let diaryRows = [];
let memoryRows = [];

function text(value) { return value == null || value === '' ? '—' : String(value); }
function formatTime(value) {
  if (!value) return '未记录时间';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}
function safeJson(value) { return JSON.stringify(value || {}, null, 2); }
function clear(node) { node.replaceChildren(); }

function renderDiaryList() {
  const list = $('diaryList'); clear(list);
  $('diaryCount').textContent = `${diaryRows.filter((item) => item.exists).length} 页`;
  if (!diaryRows.length) { list.textContent = '还没有可翻阅的日记。写下第一页后，它会留在这里。'; return; }
  diaryRows.forEach((item, index) => {
    const button = document.createElement('button');
    const date = new Date(`${item.date}T12:00:00`);
    button.type = 'button'; button.className = `entry-item ${index === 0 ? 'active' : ''} ${item.exists ? '' : 'draft'}`;
    const day = document.createElement('span'); day.className = 'entry-day'; day.textContent = date.getDate();
    const copy = document.createElement('span'); copy.className = 'entry-copy';
    const month = document.createElement('strong'); month.textContent = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`;
    const excerpt = document.createElement('small'); excerpt.textContent = item.exists ? item.excerpt || '这一天的日记' : '素材已整理，尚未写成日记';
    copy.append(month, excerpt); button.append(day, copy);
    button.addEventListener('click', () => { list.querySelectorAll('.entry-item').forEach((node) => node.classList.remove('active')); button.classList.add('active'); loadDiary(item); });
    list.append(button);
  });
}

async function loadDiary(item) {
  $('diaryProse').textContent = '正在翻到这一页…';
  const date = new Date(`${item.date}T12:00:00`);
  $('diaryDate').textContent = `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  $('diaryWeekday').textContent = `星期${weekday[date.getDay()]} · 小未来的记录`;
  $('diaryStamp').textContent = item.exists ? 'MY DIARY' : 'DRAFT PAGE';
  try {
    const journal = await window.desktopPet.memory.getDailyJournal(item.date);
    if (journal?.prose) {
      $('diaryProse').textContent = journal.prose.trim();
      $('diarySources').textContent = `这一页来自 ${Array.isArray(journal.sourceIds) ? journal.sourceIds.length : item.sourceCount || 0} 条已保存的相处与生活素材`;
    } else {
      $('diaryProse').textContent = '这一天的素材已经整理好了，但小未来还没有把它写成日记。';
      $('diarySources').textContent = '日记只会基于已保存的聊天、事件和虚拟活动来写。';
    }
  } catch {
    $('diaryProse').textContent = '这一页暂时打不开，请刷新后再试。'; $('diarySources').textContent = '';
  }
}

function rowSummary(row) {
  if (activeKind === 'episodes') return { title: formatTime(row.createdAt), summary: row.content };
  if (activeKind === 'facts') return { title: `${text(row.subjectId)} · ${text(row.predicate)}`, summary: row.objectText };
  if (activeKind === 'edges') return { title: `${text(row.fromId)} → ${text(row.toId)}`, summary: row.predicate };
  if (activeKind === 'profiles') return { title: row.id, summary: row.role };
  return { title: row.type, summary: formatTime(row.occurredAt) };
}
function detailFor(row) {
  if (activeKind === 'episodes') return { kicker: '相处片段', title: formatTime(row.createdAt), body: row.content, meta: [['来源', row.source], ['编号', row.id]] };
  if (activeKind === 'facts') return { kicker: `记住的事 · ${row.state}`, title: `${row.subjectId} ${row.predicate}`, body: row.objectText, meta: [['重要度', row.importance], ['置信度', row.confidence], ['来源', row.sourceId], ['有效期', [row.validFrom, row.validTo].filter(Boolean).join(' 至 ')]] };
  if (activeKind === 'edges') return { kicker: `关系 · ${row.state}`, title: `${row.fromId}  ${row.predicate}  ${row.toId}`, body: '这是一条可追溯的关系连接，不会单独生成未经证实的结论。', meta: [['来源', row.sourceId], ['有效期', [row.validFrom, row.validTo].filter(Boolean).join(' 至 ')], ['编号', row.id]] };
  if (activeKind === 'profiles') return { kicker: `人格画像 · ${row.role}`, title: row.id, body: safeJson({ core: row.core, learned: row.learned }), meta: [['更新时间', formatTime(row.updatedAt)]] };
  return { kicker: `事件 · ${row.privacy}`, title: row.type, body: safeJson(row.payload), meta: [['发生时间', formatTime(row.occurredAt)], ['来源', row.source], ['编号', row.id]] };
}
function showMemoryDetail(row) {
  const detail = detailFor(row); $('memoryKicker').textContent = detail.kicker; $('memoryTitle').textContent = detail.title; $('memoryBody').textContent = detail.body;
  const meta = $('memoryMeta'); clear(meta);
  detail.meta.filter(([, value]) => value != null && value !== '').forEach(([label, value]) => { const term = document.createElement('dt'); term.textContent = label; const definition = document.createElement('dd'); definition.textContent = text(value); meta.append(term, definition); });
}
function renderMemoryList() {
  const list = $('memoryList'); clear(list); $('memoryCount').textContent = `${memoryRows.length} 条`;
  if (!memoryRows.length) { $('memoryKicker').textContent = 'Memory'; $('memoryTitle').textContent = '这里还没有内容'; $('memoryBody').textContent = '新的相处片段、事实、关系和事件会在保存后显示在这里。'; clear($('memoryMeta')); list.textContent = '暂时没有已保存的内容。'; return; }
  memoryRows.forEach((row, index) => {
    const info = rowSummary(row); const button = document.createElement('button'); button.type = 'button'; button.className = `entry-item memory-entry ${index === 0 ? 'active' : ''}`;
    const title = document.createElement('strong'); title.textContent = info.title;
    const summary = document.createElement('small'); summary.textContent = info.summary;
    button.append(title, summary);
    button.addEventListener('click', () => { list.querySelectorAll('.entry-item').forEach((node) => node.classList.remove('active')); button.classList.add('active'); showMemoryDetail(row); }); list.append(button);
  }); showMemoryDetail(memoryRows[0]);
}
async function loadMemory(kind = activeKind) { activeKind = kind; $('memoryList').textContent = '正在读取…'; memoryRows = await window.desktopPet.memory.list(kind); renderMemoryList(); }
async function refresh() {
  const status = await window.desktopPet.memory.getStatus(); const box = $('statusBox'); box.className = `core-status ${status?.ok ? 'ok' : 'bad'}`; box.textContent = status?.ok ? 'SQLite 已就绪' : 'Core 未就绪';
  $('statsLine').textContent = status?.ok ? `情景 ${status.episodes} · 事实 ${status.facts} · 关系 ${status.edges} · 画像 ${status.profiles} · 事件 ${status.events} · 日记 ${status.dailyJournals}` : 'Python Core 未就绪时，面板不会读取或写入长期记忆。';
  if (!status?.ok) { diaryRows = []; renderDiaryList(); renderMemoryList(); $('diaryProse').textContent = '本地记忆 Core 尚未就绪，日记册暂时不可读取。'; return; }
  diaryRows = await window.desktopPet.memory.listDailyJournals(); renderDiaryList();
  if (diaryRows.length) await loadDiary(diaryRows[0]);
  else { $('diaryDate').textContent = '还没有日记页'; $('diaryWeekday').textContent = '小未来的记录'; $('diaryStamp').textContent = 'MY DIARY'; $('diaryProse').textContent = '在“显示设置”里点一下“写一页”，第一篇日记就会放进这本册子。'; $('diarySources').textContent = ''; }
  await loadMemory(activeKind);
}
document.querySelectorAll('.main-tab').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.main-tab').forEach((node) => node.classList.toggle('active', node === button)); $('diaryView').classList.toggle('hidden', button.dataset.view !== 'diary'); $('memoryView').classList.toggle('hidden', button.dataset.view !== 'memory'); }));
document.querySelectorAll('.memory-tab').forEach((button) => button.addEventListener('click', async () => { document.querySelectorAll('.memory-tab').forEach((node) => node.classList.toggle('active', node === button)); await loadMemory(button.dataset.kind); }));
$('refreshBtn').addEventListener('click', refresh); $('closeBtn').addEventListener('click', () => window.desktopPet.memory.closePanel());
refresh().catch((error) => { $('statusBox').textContent = `读取失败：${error.message || error}`; });
