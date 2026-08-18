const $ = (id) => document.getElementById(id);
let activeKind = 'messages';
let rows = [];
let graph = { nodes: [], edges: [] };
const memoryKinds = new Set(['messages', 'episodes', 'vectors', 'facts', 'candidates', 'edges', 'profiles', 'events']);
const mindKinds = new Set(['thoughts', 'dreams', 'reflections']);
function text(value) { return value == null || value === '' ? '—' : String(value); }
function time(value) { const date = new Date(value); return !value || Number.isNaN(date.valueOf()) ? text(value) : date.toLocaleString('zh-CN', { hour12: false }); }
function json(value) { return JSON.stringify(value || {}, null, 2); }
function clear(node) { node.replaceChildren(); }
function setGraphVisible(visible) { $('memoryReader').classList.toggle('hidden', visible); $('graphScene').classList.toggle('hidden', !visible); }
function graphLabel(id) { if (id === 'character:mirai') return '小未来'; if (id === 'owner:default') return '主人'; return String(id).replace(/^(character|owner|entity):/, ''); }
function graphPositions(nodes) {
  const positions = new Map(); const count = nodes.length;
  nodes.forEach((node, index) => { const angle = count === 1 ? 0 : (-Math.PI / 2) + (Math.PI * 2 * index / count); positions.set(node.id, { x: count === 1 ? 50 : 50 + Math.cos(angle) * 35, y: count === 1 ? 50 : 50 + Math.sin(angle) * 35 }); });
  return positions;
}
function showGraphNode(node) {
  $('graphTitle').textContent = graphLabel(node.id); $('graphNote').textContent = `${node.kind === 'character' ? '角色' : node.kind === 'owner' ? '主人' : '实体'}节点 · 已验证关系 ${node.degree} 条。关系只引用已保存的相处片段。`;
  document.querySelectorAll('.graph-node').forEach((button) => button.classList.toggle('active', button.dataset.nodeId === node.id));
}
function showGraphEdge(edge) { $('graphTitle').textContent = `${graphLabel(edge.fromId)}  ${edge.predicate}  ${graphLabel(edge.toId)}`; $('graphNote').textContent = `来源：${text(edge.sourceId)}。图谱只展示 active 关系；它不会从关系本身推导新的事实。`; }
function renderGraph() {
  setGraphVisible(true); const list = $('memoryList'); clear(list); const nodes = graph.nodes.slice(0, 18); const edges = graph.edges.filter((edge) => nodes.some((node) => node.id === edge.fromId) && nodes.some((node) => node.id === edge.toId));
  $('memoryCount').textContent = `${graph.nodes.length} 点 · ${graph.edges.length} 边`; const stage = $('graphStage'); clear(stage);
  if (!nodes.length) { $('graphTitle').textContent = '还没有可画出的图谱'; $('graphNote').textContent = '保存带来源的图关系后，节点会在这里出现。内心活动、梦境和反思不会进入图谱。'; stage.textContent = '暂时没有已验证的关系节点。'; return; }
  const positions = graphPositions(nodes); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none');
  edges.forEach((edge) => { const from = positions.get(edge.fromId); const to = positions.get(edge.toId); if (!from || !to) return; const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.classList.add('graph-edge'); line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y); const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = edge.predicate; line.append(title); svg.append(line); }); stage.append(svg);
  nodes.forEach((node) => { const point = positions.get(node.id); const button = document.createElement('button'); button.type = 'button'; button.className = 'graph-node'; button.dataset.nodeId = node.id; button.style.left = `${point.x}%`; button.style.top = `${point.y}%`; button.textContent = graphLabel(node.id); button.addEventListener('click', () => showGraphNode(node)); stage.append(button); });
  graph.edges.forEach((edge, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = `entry-item memory-entry ${index === 0 ? 'active' : ''}`; const title = document.createElement('strong'); title.textContent = `${graphLabel(edge.fromId)} → ${graphLabel(edge.toId)}`; const body = document.createElement('small'); body.textContent = edge.predicate; button.append(title, body); button.addEventListener('click', () => { list.querySelectorAll('.entry-item').forEach((node) => node.classList.remove('active')); button.classList.add('active'); showGraphEdge(edge); }); list.append(button); });
  $('graphTitle').textContent = '关系图谱'; $('graphNote').textContent = `显示 ${nodes.length} 个节点与 ${edges.length} 条可追溯关系${graph.nodes.length > nodes.length ? '；其余节点仍可在图关系列表中查看。' : '。'}`;
}
function summary(row) {
  if (activeKind === 'messages') return { title: `${row.role === 'user' ? '主人' : '小未来'} · ${time(row.createdAt)}`, body: row.content };
  if (activeKind === 'episodes') return { title: time(row.createdAt), body: row.content };
  if (activeKind === 'vectors') return { title: `${row.model} · ${row.dimensions} 维`, body: row.content };
  if (activeKind === 'facts') return { title: `${text(row.subjectId)} · ${text(row.predicate)}`, body: row.objectText };
  if (activeKind === 'candidates') return { title: `${text(row.subjectId)} · ${text(row.predicate)}`, body: `${text(row.objectText)} · ${row.status}` };
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
  if (activeKind === 'candidates') return { kicker: `候选事实 · ${row.status}`, title: `${row.subjectId} ${row.predicate}`, body: row.objectText, meta: [['置信度', row.confidence], ['观察时间', time(row.observedAt)], ['来源 Episode', row.sourceEpisodeId], ['冲突断言', row.conflicts?.join(', ') || '无'], ['提取方式', row.extraction?.method]] };
  if (activeKind === 'edges') return { kicker: `图关系 · ${row.state}`, title: `${row.fromId}  ${row.predicate}  ${row.toId}`, body: '关系必须能追溯到来源片段，图谱本身不产生新的事实。', meta: [['来源', row.sourceId], ['编号', row.id]] };
  if (activeKind === 'profiles') return { kicker: `人格画像 · ${row.role}`, title: row.id, body: json({ core: row.core, learned: row.learned }), meta: [['更新时间', time(row.updatedAt)]] };
  if (activeKind === 'thoughts') return { kicker: `内心活动 · ${row.state}`, title: `${row.kind} · ${time(row.createdAt)}`, body: row.content, meta: [['确定性', row.certainty], ['情绪快照', json(row.emotion)], ['来源', row.sourceIds?.join(', ')], ['过期时间', time(row.expiresAt)]] };
  if (activeKind === 'dreams') return { kicker: `梦境 · ${row.state}`, title: `${row.dreamDate} 的梦`, body: row.content, meta: [['虚构体验', row.isFiction ? '是，不是现实事实' : '否'], ['情绪影响', json(row.emotion)], ['来源', row.sourceIds?.join(', ')]] };
  if (activeKind === 'reflections') return { kicker: `反思 · ${row.kind} · ${row.state}`, title: `${row.periodStart} 至 ${row.periodEnd}`, body: row.content, meta: [['置信度', row.confidence], ['依据', row.sourceIds?.join(', ')], ['生成时间', time(row.createdAt)]] };
  return { kicker: `事件 · ${row.privacy}`, title: row.type, body: json(row.payload), meta: [['发生时间', time(row.occurredAt)], ['来源', row.source], ['编号', row.id]] };
}
function show(row) { const item = detail(row); $('memoryKicker').textContent = item.kicker; $('memoryTitle').textContent = item.title; $('memoryBody').textContent = item.body; const meta = $('memoryMeta'); clear(meta); (item.meta || []).filter(([, value]) => value != null && value !== '').forEach(([label, value]) => { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = text(value); meta.append(dt, dd); }); }
function render() {
  setGraphVisible(false);
  const list = $('memoryList'); clear(list); $('memoryCount').textContent = `${rows.length} 条`;
  if (!rows.length) { $('memoryKicker').textContent = activeKind === 'vectors' ? '向量索引尚未建立' : 'Memory'; $('memoryTitle').textContent = activeKind === 'vectors' ? '还没有向量记忆' : '这里还没有内容'; $('memoryBody').textContent = activeKind === 'vectors' ? '当前仍是关键词和来源浏览阶段；向量模型接入后，语义片段会出现在这里。' : '新的内容会在保存后显示在这里。'; clear($('memoryMeta')); list.textContent = '暂时没有已保存的内容。'; return; }
  rows.forEach((row, index) => { const info = summary(row); const button = document.createElement('button'); button.type = 'button'; button.className = `entry-item memory-entry ${index === 0 ? 'active' : ''}`; const title = document.createElement('strong'); title.textContent = info.title; const body = document.createElement('small'); body.textContent = info.body; button.append(title, body); button.addEventListener('click', () => { list.querySelectorAll('.entry-item').forEach((node) => node.classList.remove('active')); button.classList.add('active'); show(row); }); list.append(button); }); show(rows[0]);
}
async function load(kind = activeKind) { activeKind = kind; $('memoryList').textContent = '正在读取…'; if (kind === 'graph') { graph = await window.desktopPet.memory.getGraph(); renderGraph(); return; } rows = memoryKinds.has(kind) ? await window.desktopPet.memory.list(kind) : await window.desktopPet.memory.listMind(kind); render(); }
async function refresh() { const status = await window.desktopPet.memory.getStatus(); $('statusBox').className = `core-status ${status?.ok ? 'ok' : 'bad'}`; $('statusBox').textContent = status?.ok ? 'SQLite 已就绪' : 'Core 未就绪'; $('statsLine').textContent = status?.ok ? `消息 ${status.messages} · 向量 ${status.vectors} · 事实 ${status.facts} · 图关系 ${status.edges} · 内心 ${status.thoughts} · 梦境 ${status.dreams} · 反思 ${status.reflections}` : 'Python Core 未就绪时，面板不会读取或写入长期记忆。'; if (!status?.ok) { rows = []; render(); return; } await load(activeKind); }
document.querySelectorAll('.memory-tab').forEach((button) => button.addEventListener('click', async () => { document.querySelectorAll('.memory-tab').forEach((node) => node.classList.toggle('active', node === button)); await load(button.dataset.kind); }));
$('refreshBtn').addEventListener('click', refresh); $('closeBtn').addEventListener('click', () => window.desktopPet.memory.closePanel()); refresh().catch((error) => { $('statusBox').textContent = `读取失败：${error.message || error}`; });
