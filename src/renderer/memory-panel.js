const $ = (id) => document.getElementById(id);
let activeKind = 'messages';
let rows = [];
const memoryKinds = new Set(['messages', 'episodes', 'vectors', 'facts', 'edges', 'profiles', 'events']);
const mindKinds = new Set(['thoughts', 'dreams', 'reflections']);
function text(value) { return value == null || value === '' ? '—' : String(value); }
function time(value) { const date = new Date(value); return !value || Number.isNaN(date.valueOf()) ? text(value) : date.toLocaleString('zh-CN', { hour12: false }); }
function json(value) { return JSON.stringify(value || {}, null, 2); }
function clear(node) { node.replaceChildren(); }
function summary(row) {
  if (activeKind === 'messages') return { title: `${row.role === 'user' ? '主人' : '小未来'} · ${time(row.createdAt)}`, body: row.content };
  if (activeKind === 'episodes') return { title: time(row.createdAt), body: row.content };
  if (activeKind === 'vectors') return { title: `${row.model} · ${row.dimensions} 维`, body: row.content };
  if (activeKind === 'facts') return { title: `${text(row.subjectId)} · ${text(row.predicate)}`, body: row.objectText };
  if (activeKind === 'edges') return { title: `${text(row.fromId)} → ${text(row.toId)}`, body: row.predicate };
  if (activeKind === 'profiles') return { title: row.id, body: row.role };
  if (activeKind === 'thoughts') return { title: `${row.kind} · ${time(row.createdAt)}`, body: row.content };
  if (activeKind === 'dreams') return { title: `${row.dreamDate} 的梦`, body: row.content };
  if (activeKind === 'reflections') return { title: `${row.periodStart} 至 ${row.periodEnd}`, body: row.content };
  return { title: row.type, body: time(row.occurredAt) };
}
function detail(row) {
  if (activeKind === 'messages') return { kicker: `${row.role === 'user' ? '全量对话 · 主人' : '全量对话 · 小未来'}`, title: time(row.createdAt), body: row.content, meta: [['会话', row.conversationId], ['序号', row.sequence], ['来源', row.source]] };
  if (activeKind === 'episodes') return { kicker: '相处片段', title: time(row.createdAt), body: row.content, meta: [['来源', row.source], ['编号', row.id]] };
  if (activeKind === 'vectors') return { kicker: `向量记忆 · ${row.state}`, title: `${row.model} (${row.dimensions} 维)`, body: row.content, meta: [['区块', row.chunkId], ['来源', row.sourceIds?.join(', ')], ['建立时间', time(row.createdAt)]] };
  if (activeKind === 'facts') return { kicker: `事实 · ${row.state}`, title: `${row.subjectId} ${row.predicate}`, body: row.objectText, meta: [['重要度', row.importance], ['置信度', row.confidence], ['来源', row.sourceId]] };
  if (activeKind === 'edges') return { kicker: `图关系 · ${row.state}`, title: `${row.fromId}  ${row.predicate}  ${row.toId}`, body: '关系必须能追溯到来源片段，图谱本身不产生新的事实。', meta: [['来源', row.sourceId], ['编号', row.id]] };
  if (activeKind === 'profiles') return { kicker: `人格画像 · ${row.role}`, title: row.id, body: json({ core: row.core, learned: row.learned }), meta: [['更新时间', time(row.updatedAt)]] };
  if (activeKind === 'thoughts') return { kicker: `内心活动 · ${row.state}`, title: `${row.kind} · ${time(row.createdAt)}`, body: row.content, meta: [['确定性', row.certainty], ['情绪快照', json(row.emotion)], ['来源', row.sourceIds?.join(', ')], ['过期时间', time(row.expiresAt)]] };
  if (activeKind === 'dreams') return { kicker: `梦境 · ${row.state}`, title: `${row.dreamDate} 的梦`, body: row.content, meta: [['虚构体验', row.isFiction ? '是，不是现实事实' : '否'], ['情绪影响', json(row.emotion)], ['来源', row.sourceIds?.join(', ')]] };
  if (activeKind === 'reflections') return { kicker: `反思 · ${row.kind} · ${row.state}`, title: `${row.periodStart} 至 ${row.periodEnd}`, body: row.content, meta: [['置信度', row.confidence], ['依据', row.sourceIds?.join(', ')], ['生成时间', time(row.createdAt)]] };
  return { kicker: `事件 · ${row.privacy}`, title: row.type, body: json(row.payload), meta: [['发生时间', time(row.occurredAt)], ['来源', row.source], ['编号', row.id]] };
}
function show(row) { const item = detail(row); $('memoryKicker').textContent = item.kicker; $('memoryTitle').textContent = item.title; $('memoryBody').textContent = item.body; const meta = $('memoryMeta'); clear(meta); (item.meta || []).filter(([, value]) => value != null && value !== '').forEach(([label, value]) => { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = text(value); meta.append(dt, dd); }); }
function render() {
  const list = $('memoryList'); clear(list); $('memoryCount').textContent = `${rows.length} 条`;
  if (!rows.length) { $('memoryKicker').textContent = activeKind === 'vectors' ? '向量索引尚未建立' : 'Memory'; $('memoryTitle').textContent = activeKind === 'vectors' ? '还没有向量记忆' : '这里还没有内容'; $('memoryBody').textContent = activeKind === 'vectors' ? '当前仍是关键词和来源浏览阶段；向量模型接入后，语义片段会出现在这里。' : '新的内容会在保存后显示在这里。'; clear($('memoryMeta')); list.textContent = '暂时没有已保存的内容。'; return; }
  rows.forEach((row, index) => { const info = summary(row); const button = document.createElement('button'); button.type = 'button'; button.className = `entry-item memory-entry ${index === 0 ? 'active' : ''}`; const title = document.createElement('strong'); title.textContent = info.title; const body = document.createElement('small'); body.textContent = info.body; button.append(title, body); button.addEventListener('click', () => { list.querySelectorAll('.entry-item').forEach((node) => node.classList.remove('active')); button.classList.add('active'); show(row); }); list.append(button); }); show(rows[0]);
}
async function load(kind = activeKind) { activeKind = kind; $('memoryList').textContent = '正在读取…'; rows = memoryKinds.has(kind) ? await window.desktopPet.memory.list(kind) : await window.desktopPet.memory.listMind(kind); render(); }
async function refresh() { const status = await window.desktopPet.memory.getStatus(); $('statusBox').className = `core-status ${status?.ok ? 'ok' : 'bad'}`; $('statusBox').textContent = status?.ok ? 'SQLite 已就绪' : 'Core 未就绪'; $('statsLine').textContent = status?.ok ? `消息 ${status.messages} · 向量 ${status.vectors} · 事实 ${status.facts} · 图关系 ${status.edges} · 内心 ${status.thoughts} · 梦境 ${status.dreams} · 反思 ${status.reflections}` : 'Python Core 未就绪时，面板不会读取或写入长期记忆。'; if (!status?.ok) { rows = []; render(); return; } await load(activeKind); }
document.querySelectorAll('.memory-tab').forEach((button) => button.addEventListener('click', async () => { document.querySelectorAll('.memory-tab').forEach((node) => node.classList.toggle('active', node === button)); await load(button.dataset.kind); }));
$('refreshBtn').addEventListener('click', refresh); $('closeBtn').addEventListener('click', () => window.desktopPet.memory.closePanel()); refresh().catch((error) => { $('statusBox').textContent = `读取失败：${error.message || error}`; });
