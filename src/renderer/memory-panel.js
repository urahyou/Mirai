const $ = (id) => document.getElementById(id);

let feedbackTimer = null;

function showFeedback(status, isError = false) {
  const node = $('saveStatus');
  clearTimeout(feedbackTimer);
  node.textContent = status;
  node.classList.remove('show');
  requestAnimationFrame(() => node.classList.add('show'));
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  feedbackTimer = setTimeout(() => {
    node.classList.remove('show');
    node.textContent = '';
  }, 2400);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function renderStatus() {
  try {
    const st = await window.desktopPet.memory.getStatus();
    const enabled = Boolean(st?.enabled);
    const box = $('statusBox');
    box.innerHTML = enabled
      ? `记忆开关：<b>已开启</b>　·　嵌入式：<b>${escapeHtml(st.embedModel || '')}</b>（本地）<br>
        存储：<b>本地 SQLite</b>　·　相关性阈值：<b>${Number(st.threshold).toFixed(2)}</b><br>
        提炼：<b>${escapeHtml(st.distillProvider || '')}</b>`
      : '记忆开关：<span class="off">已关闭</span>（在 .env 设 MEMU_ENABLED=true 可开启）';
  } catch {
    $('statusBox').textContent = '无法读取记忆状态';
  }
}

async function renderDistillSelect() {
  const select = $('distillModel');
  try {
    const data = await window.desktopPet.memory.listDistillModels();
    const models = Array.isArray(data?.models) ? data.models : [];
    select.innerHTML = models.length
      ? models.map((m) => `<option value="${escapeHtml(m.id)}" ${m.current ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')
      : '<option value="follow">本机 Ollama 不可达，跟随对话模型</option>';
  } catch {
    select.innerHTML = '<option value="follow">无法加载模型列表</option>';
  }
}

async function onDistillChange() {
  const select = $('distillModel');
  const model = select.value || 'follow';
  if (select.dataset.busy) return;
  select.dataset.busy = '1';
  try {
    await window.desktopPet.memory.setDistillModel(model);
    showFeedback(model === 'follow' ? '已切换：跟随对话模型' : `已切换：${model}`);
    await renderStatus();
  } catch {
    showFeedback('切换失败，请重试', true);
  } finally {
    delete select.dataset.busy;
  }
}

async function renderList() {
  $('memError').textContent = '';
  try {
    const res = await window.desktopPet.memory.list();
    const memories = Array.isArray(res?.memories) ? res.memories : [];
    const list = $('memList');
    if (!memories.length) {
      list.innerHTML = '<div class="mem-empty">还没有记忆。多和主人聊聊天，小未来会自动把值得记住的事归档到这里。</div>';
      return;
    }
    list.innerHTML = memories.map((m, idx) => `
      <div class="mem-item">
        <div class="mem-item-head">
          <span class="mem-item-name">${escapeHtml(m.name)}</span>
          <span class="mem-item-track">${escapeHtml(m.track || 'memory')}</span>
        </div>
        <div class="mem-item-desc">${escapeHtml(m.description || '')}</div>
        ${m.content ? `<div class="mem-item-content">${escapeHtml(m.content)}</div>` : ''}
        <div style="margin-top:8px;display:flex;justify-content:flex-end;">
          <button class="btn small ghost" data-remove="${idx}" type="button">遗忘</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => removeMemory(memories[Number(btn.dataset.remove)]));
    });
  } catch (e) {
    $('memError').textContent = '读取记忆失败：' + (e?.message || e);
  }
}

async function removeMemory(m) {
  if (!m || !m.name) return;
  if (!window.confirm(`确定要删除这条记忆吗？\n「${m.name}」`)) return;
  try {
    const res = await window.desktopPet.memory.remove(m.name, m.track || 'memory');
    if (res?.ok) {
      showFeedback('已遗忘');
      renderList();
    } else {
      showFeedback('删除失败：' + (res?.error || '未知错误'), true);
    }
  } catch {
    showFeedback('删除失败，请重试', true);
  }
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.memory.closePanel());
  $('refreshBtn').addEventListener('click', () => {
    renderStatus();
    renderList();
    renderDistillSelect();
    showFeedback('已刷新');
  });
  $('distillModel').addEventListener('change', onDistillChange);
  await renderStatus();
  await renderList();
  await renderDistillSelect();
}

init();
