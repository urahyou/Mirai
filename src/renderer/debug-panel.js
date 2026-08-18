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
    $('detailJson').textContent = '发送一条聊天后，这里会显示完整请求与返回内容。';
    return;
  }
  selectedId = entry.id;
  $('detailTitle').textContent = shortKind(entry.kind);
  $('detailMeta').textContent = `${formatTime(entry.startedAt)} · ${entry.endpoint || ''}`;
  $('detailStatus').textContent = entry.status === 'ok' ? '完成' : entry.status === 'empty' ? '空响应' : '失败';
  $('detailStatus').className = `status ${entry.status || 'error'}`;
  $('detailJson').textContent = JSON.stringify(entry, null, 2);
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
