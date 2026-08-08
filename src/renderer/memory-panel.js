/* 记忆库面板（U3）：分层展示 + 清理建议 + 自动记忆设置 + 沉淀日志 */
const $ = (sel) => document.querySelector(sel);
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TYPE_LABEL = { preference: '偏好', profile: '资料', episodic: '事件', relationship: '关系', work: '工作', schedule: '日程', other: '其他' };
const TAG_LABEL = {
  expired: '⏰ 已过期', lowValue: '🪤 低价值', unused: '🕰 长期未用',
  duplicate: '🔁 疑似重复', legacy: '⚠ 旧数据',
};
const score = (n) => (n == null ? 0 : Math.round(Number(n) * 4));

let allMemories = []; // 全部（含 archived）
let trashMemories = [];
let layer = 'core';
let searchTerm = '';
let editOpen = null; // 正在编辑的记忆 id

async function refresh() {
  const [list, trash, stats] = await Promise.all([
    window.desktopPet.memory.list({ includeArchived: true }),
    window.desktopPet.memory.list({ trashOnly: true }),
    window.desktopPet.memory.stats(),
  ]);
  allMemories = list || [];
  trashMemories = trash || [];
  renderCounts(stats);
  renderHygiene(stats && stats.hygiene);
  renderAuto(stats);
  renderLog(stats && stats.judgeLog);
  renderList();
}

function visibleMemories() {
  const base = layer === 'trash' ? trashMemories : allMemories;
  let mems = base.slice();
  if (layer === 'core') mems = mems.filter((m) => m.status === 'core' && !m.deletedAt);
  if (layer === 'active') mems = mems.filter((m) => m.status !== 'core' && m.status !== 'compressed' && !m.deletedAt && !m.archivedAt);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    mems = mems.filter((m) => (m.content || '').toLowerCase().includes(q));
  }
  // 默认按「最近访问 × 重要性」综合权重降序
  mems.sort((a, b) => {
    const va = (a.importance || 0) * (0.5 + Math.min((a.accessCount || 0), 20) / 20);
    const vb = (b.importance || 0) * (0.5 + Math.min((b.accessCount || 0), 20) / 20);
    return vb - va;
  });
  return mems;
}

function renderCounts(stats) {
  const c = stats && stats.counts;
  if (!c) { $('#mp-count-sub').textContent = ''; return; }
  $('#mp-count-sub').textContent = `常驻 ${c.core} · 活跃 ${c.active} · 归档 ${c.archived} · 回收站 ${c.trash}`;
}

function renderHygiene(list) {
  const rows = (list || []).filter((s) => s && s.id);
  const count = rows.length;
  $('#mp-hygiene-count').textContent = count ? count : '';
  $('#mp-hygiene').hidden = count === 0;
  const box = $('#mp-hygiene-rows');
  box.innerHTML = '';
  for (const s of rows) {
    const mem = allMemories.find((m) => m.id === s.id);
    if (!mem) continue;
    const row = document.createElement('div');
    row.className = 'mp-hygiene-row';
    const tag = document.createElement('span');
    tag.className = 'mp-hygiene-tag';
    tag.textContent = TAG_LABEL[s.tag] || s.tag;
    const content = document.createElement('span');
    content.className = 'mp-content';
    content.textContent = mem.content;
    const act = document.createElement('button');
    act.className = 'btn small danger mp-hygiene-act';
    act.textContent = s.tag === 'expired' ? '归档' : '删除';
    act.addEventListener('click', async () => {
      if (s.tag === 'expired') { await window.desktopPet.memory.archive(mem.id); }
      else { await window.desktopPet.memory.remove(mem.id); }
      await refresh();
    });
    row.append(tag, content, act);
    box.appendChild(row);
  }
  $('#mp-hygiene-archive-all').hidden = count === 0;
}

function renderAuto(stats) {
  const auto = stats && stats.memoryAuto !== false;
  $('#mp-auto-switch').checked = !!auto;
  const iv = (stats && stats.memoryAutoInterval) || 60000;
  $('#mp-auto-interval').value = String(iv);
}

function renderLog(log) {
  const box = $('#mp-log-rows');
  box.innerHTML = '';
  if (!log || !log.length) {
    box.innerHTML = '<div class="mp-log-row">还没有沉淀记录。聊几句，小未来会自动提炼值得记住的信息。</div>';
    return;
  }
  for (const e of log) {
    const row = document.createElement('div');
    row.className = 'mp-log-row';
    const time = document.createElement('span');
    time.textContent = (e.time || '').slice(5, 16).replace('T', ' ');
    const body = document.createElement('span');
    if (e.kind === 'wrote') {
      body.innerHTML = `<b>记下了</b> ${escapeHtml(e.content || '')}`;
    } else if (e.kind === 'none') {
      body.textContent = '本轮没有值得记住的信息';
    } else if (e.kind === 'skipped') {
      body.textContent = e.reason === 'llm' ? '提炼服务暂时不可用，下次再试' : '跳过';
    } else {
      body.textContent = e.kind || '';
    }
    row.append(time, body);
    box.appendChild(row);
  }
}

function renderList() {
  const list = $('#mp-list');
  const mems = visibleMemories();
  list.innerHTML = '';
  if (!mems.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    empty.textContent = layer === 'trash' ? '回收站是空的' : '这里还没有记忆';
    list.appendChild(empty);
    return;
  }
  for (const m of mems) list.appendChild(card(m));
}

function sourceLabel(m) {
  if (m.source === 'judge') return '自动';
  if (m.source === 'user') return '手动';
  return '旧数据';
}
function isLegacy(m) {
  return m.source && m.source !== 'judge' && m.source !== 'user';
}

function buildMeta(m) {
  const d = document.createElement('div');
  d.className = 'mp-meta';
  d.appendChild(scoreDots(m.importance));
  d.appendChild(tag('置信 ' + ((m.confidence == null ? 0 : m.confidence).toFixed(1))));
  d.appendChild(tag('访问 ×' + (m.accessCount || 0)));
  d.appendChild(tag('记于 ' + (m.createdAt || '').slice(0, 10)));
  if (m.archivedAt) d.appendChild(tag('已归档'));
  if (m.deletedAt) d.appendChild(tag('回收站'));
  if (m.status === 'compressed') d.appendChild(tag('已压缩'));
  if (m.isSummary) d.appendChild(tag('摘要'));
  return d;
}
function scoreDots(v) {
  const n = score(v);
  const s = document.createElement('span');
  s.className = 'mp-score';
  s.title = '重要性 ' + (v == null ? 0 : v);
  s.textContent = '●'.repeat(n) + '○'.repeat(4 - n);
  return s;
}
function tag(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

function card(m) {
  const el = document.createElement('div');
  el.className = 'mp-card' + (m.status === 'core' ? ' core' : '') + (m.deletedAt ? ' trash' : '');

  const top = document.createElement('div');
  top.className = 'mp-card-top';
  const type = document.createElement('span');
  type.className = 'mp-type';
  type.textContent = TYPE_LABEL[m.type] || m.type;
  const content = document.createElement('span');
  content.className = 'mp-content';
  content.textContent = m.content;
  const source = document.createElement('span');
  source.className = 'mp-source' + (isLegacy(m) ? ' old' : '');
  source.textContent = sourceLabel(m);
  top.append(type, content, source);

  const meta = buildMeta(m);
  el.append(top, meta);

  const acts = document.createElement('div');
  acts.className = 'mp-acts';
  if (m.deletedAt) {
    acts.appendChild(action('还原', async () => { await window.desktopPet.memory.restore(m.id); await refresh(); }));
    acts.appendChild(action('彻底删除', async () => {
      if (!confirm('彻底删除这条记忆？此操作不可撤销。')) return;
      await window.desktopPet.memory.purge(m.id);
      await refresh();
    }, true));
  } else {
    if (m.status !== 'core') {
      acts.appendChild(action('设为常驻', async () => { await window.desktopPet.memory.update(m.id, { status: 'core' }); await refresh(); }));
    } else {
      acts.appendChild(action('降级', async () => { await window.desktopPet.memory.update(m.id, { status: 'active' }); await refresh(); }));
    }
    if (!m.archivedAt) {
      acts.appendChild(action('归档', async () => { await window.desktopPet.memory.archive(m.id); await refresh(); }));
    }
    acts.appendChild(action('编辑', () => toggleEdit(el, m)));
    acts.appendChild(action('不要记住', async () => {
      if (!confirm('此后小未来不再记住这类内容？')) return;
      await window.desktopPet.memory.doNotRemember({ type: m.type, content: m.content });
      await window.desktopPet.memory.remove(m.id);
      await refresh();
    }, true));
    acts.appendChild(action('删除✕', async () => {
      if (!confirm('删除后可在回收站还原，确定？')) return;
      await window.desktopPet.memory.remove(m.id);
      await refresh();
    }, true));
  }
  el.appendChild(acts);

  if (editOpen === m.id) el.appendChild(editBox(m));
  return el;
}

function action(label, fn, danger) {
  const b = document.createElement('button');
  b.className = 'btn small' + (danger ? ' danger' : ' ghost');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function toggleEdit(el, m) {
  editOpen = editOpen === m.id ? null : m.id;
  renderList();
}

function editBox(m) {
  const box = document.createElement('div');
  box.className = 'mp-edit-box';
  const ta = document.createElement('textarea');
  ta.value = m.content;
  ta.rows = 2;
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(tag('重要性'));
  const range = document.createElement('input');
  range.type = 'range';
  range.min = 0; range.max = 1; range.step = 0.05;
  range.value = m.importance == null ? 0 : m.importance;
  row.appendChild(range);
  row.appendChild(tag(range.value));

  const save = action('保存', async () => {
    await window.desktopPet.memory.update(m.id, { content: ta.value.trim() || m.content, importance: Number(range.value) });
    editOpen = null;
    await refresh();
  });
  const cancel = action('取消', () => { editOpen = null; renderList(); });

  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  btnRow.append(save, cancel);
  box.append(ta, row, btnRow);
  return box;
}

/* ---------- 事件绑定 ---------- */
$('#mp-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.mp-tab');
  if (!btn) return;
  layer = btn.dataset.lay;
  [...$('#mp-tabs').children].forEach((b) => b.classList.toggle('active', b === btn));
  renderList();
});
$('#mp-search').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderList(); });
$('#mp-export').addEventListener('click', async () => {
  const data = await window.desktopPet.memory.export();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `memory-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#mp-auto-switch').addEventListener('change', async (e) => {
  await window.desktopPet.settings.set({ memoryAuto: e.target.checked });
});
$('#mp-auto-interval').addEventListener('change', async (e) => {
  await window.desktopPet.settings.set({ memoryAutoInterval: Number(e.target.value) });
});
$('#mp-hygiene-archive-all').addEventListener('click', async () => {
  const stats = await window.desktopPet.memory.stats();
  const list = (stats && stats.hygiene) || [];
  for (const s of list) {
    const mem = allMemories.find((m) => m.id === s.id);
    if (!mem) continue;
    if (s.tag === 'expired') await window.desktopPet.memory.archive(mem.id);
    else await window.desktopPet.memory.remove(mem.id);
  }
  await refresh();
});

refresh();
