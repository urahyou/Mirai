const $ = (id) => document.getElementById(id);

let entries = [];
let selectedId = null;

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function shortKind(kind) {
  return ({ chat: '聊天', 'pet-line': '点击互动', 'history-summary': '历史压缩' })[kind] || kind || '模型请求';
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addTextSection(target, title, text, className = '') {
  if (text === undefined || text === null || text === '') return;
  const section = make('section', `debug-section ${className}`.trim());
  section.append(make('h2', 'debug-section-title', title));
  section.append(make('pre', 'debug-text', String(text)));
  target.append(section);
}

function addMetaSection(target, entry) {
  const request = entry.request || {};
  const rows = [
    ['模型', request.model],
    ['温度', request.temperature],
    ['Top P', request.top_p],
    ['流式输出', request.stream ? '是' : '否'],
    ['耗时', entry.durationMs == null ? '—' : `${entry.durationMs}ms`],
  ];
  const section = make('section', 'debug-section');
  section.append(make('h2', 'debug-section-title', '请求参数'));
  const grid = make('dl', 'debug-meta-grid');
  for (const [label, value] of rows) {
    if (value === undefined || value === null) continue;
    grid.append(make('dt', '', label), make('dd', '', String(value)));
  }
  section.append(grid);
  target.append(section);
}

function addContextMetaSection(target, context) {
  if (!context || typeof context !== 'object') return;
  const rows = [
    ['总预算', context.maxTokens == null ? undefined : `${context.maxTokens} tokens`],
    ['系统提示', context.systemTokens == null ? undefined : `${context.systemTokens} tokens`],
    ['当前输入', context.inputTokens == null ? undefined : `${context.inputTokens} tokens`],
    ['历史预算', context.historyBudget == null ? undefined : `${context.historyBudget} tokens`],
    ['历史估算', context.estimatedHistoryTokens == null ? undefined : `${context.estimatedHistoryTokens} tokens`],
    ['历史实际注入', context.selectedHistoryTokens == null ? undefined : `${context.selectedHistoryTokens} tokens`],
    ['回复预留', context.outputReserveTokens == null ? undefined : `${context.outputReserveTokens} tokens`],
    ['估算总占用', context.estimatedTotalTokens == null ? undefined : `${context.estimatedTotalTokens} tokens`],
    ['触发压缩', context.compressed === undefined ? undefined : (context.compressed ? '是' : '否')],
  ].filter(([, value]) => value !== undefined);
  if (!rows.length) return;
  const section = make('section', 'debug-section');
  section.append(make('h2', 'debug-section-title', '上下文管理'));
  const grid = make('dl', 'debug-meta-grid');
  for (const [label, value] of rows) grid.append(make('dt', '', label), make('dd', '', value));
  section.append(grid);
  target.append(section);
}

function addMessages(target, messages) {
  if (!Array.isArray(messages) || !messages.length) return;
  const section = make('section', 'debug-section');
  section.append(make('h2', 'debug-section-title', `实际发送的 messages（${messages.length} 条）`));
  const list = make('div', 'message-list');
  messages.forEach((message, index) => {
    const card = make('article', `message-card ${message?.role || 'unknown'}`);
    card.append(make('div', 'message-role', `${index + 1}. ${message?.role || 'unknown'}`));
    card.append(make('pre', 'message-text', String(message?.content ?? '')));
    list.append(card);
  });
  section.append(list);
  target.append(section);
}

function buildDetail(entry) {
  const root = document.createDocumentFragment();
  if (entry.context) {
    addContextMetaSection(root, entry.context);
    addTextSection(root, '检索到的长期记忆', entry.context.memoryContext);
    addTextSection(root, '运行时状态与环境感知', entry.context.state);
  }
  addMetaSection(root, entry);
  addMessages(root, entry.request?.messages);
  addTextSection(root, 'Completion', entry.response?.completion, 'completion');
  addTextSection(root, '错误', entry.error, 'error');
  if (!root.childNodes.length) root.append(make('p', 'debug-empty', '这条记录没有可显示的请求正文。'));
  return root;
}

function renderList() {
  const box = $('entryList');
  box.replaceChildren();
  $('entryCount').textContent = `${entries.length} 条`;
  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `debug-entry${entry.id === selectedId ? ' active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = shortKind(entry.kind);
    const summary = document.createElement('span');
    summary.textContent = `${formatTime(entry.startedAt)} · ${entry.providerLabel || entry.provider || '未知模型'}`;
    const state = document.createElement('small');
    state.textContent = entry.status === 'ok' ? `完成 ${entry.durationMs ?? '—'}ms` : entry.status === 'empty' ? '空响应' : `失败${entry.durationMs != null ? ` ${entry.durationMs}ms` : ''}`;
    item.append(title, summary, state);
    item.addEventListener('click', () => { selectedId = entry.id; render(); });
    box.append(item);
  }
}

function renderDetail() {
  const entry = entries.find((item) => item.id === selectedId) || entries[0];
  if (!entry) {
    selectedId = null;
    $('detailTitle').textContent = '尚无记录';
    $('detailMeta').textContent = '';
    $('detailStatus').textContent = '';
    $('detailStatus').className = 'status';
    $('detailContent').replaceChildren('发送一条聊天后，这里会显示完整请求与返回内容。');
    return;
  }
  selectedId = entry.id;
  $('detailTitle').textContent = shortKind(entry.kind);
  $('detailMeta').textContent = `${formatTime(entry.startedAt)} · ${entry.endpoint || ''}`;
  $('detailStatus').textContent = entry.status === 'ok' ? '完成' : entry.status === 'empty' ? '空响应' : '失败';
  $('detailStatus').className = `status ${entry.status || 'error'}`;
  $('detailContent').replaceChildren(buildDetail(entry));
}

function render() { renderList(); renderDetail(); }

async function refresh() {
  entries = await window.desktopPet.debug.getEntries();
  if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries[0]?.id || null;
  render();
}

$('refreshBtn').addEventListener('click', () => { void refresh(); });
$('clearBtn').addEventListener('click', async () => { await window.desktopPet.debug.clearEntries(); selectedId = null; await refresh(); });
$('closeBtn').addEventListener('click', () => window.desktopPet.debug.closePanel());

void refresh();
