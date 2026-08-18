const $ = (id) => document.getElementById(id);

const STATE_LABELS = {
  proposed: '已登记', planning: '生成中', 'pending-approval': '待审批', approved: '已批准',
  running: '执行中', completed: '已完成', rejected: '已拒绝', blocked: '已阻止', failed: '失败',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function proposalText(task) {
  const proposal = task?.result?.proposal;
  if (!proposal?.parameters) return '';
  const { title, body } = proposal.parameters;
  return [title ? `标题：${title}` : '', body ? `正文：${body}` : ''].filter(Boolean).join('\n');
}

function renderTasks(tasks) {
  const list = $('taskList'); list.textContent = '';
  if (!Array.isArray(tasks) || !tasks.length) { list.appendChild(node('div', 'empty', '暂无任务')); return; }
  for (const task of tasks) {
    const item = node('article', 'task-item');
    const top = node('div', 'task-top');
    top.append(node('strong', 'task-title', task.objective || task.capability), node('span', 'task-state', STATE_LABELS[task.state] || task.state));
    item.appendChild(top);
    if (task.result?.summary) item.appendChild(node('p', 'task-summary', task.result.summary));
    const proposal = proposalText(task);
    if (proposal) item.appendChild(node('pre', 'task-proposal', proposal));
    if (task.error) item.appendChild(node('p', 'task-summary', task.error));
    if (task.state === 'pending-approval') {
      const actions = node('div', 'task-actions');
      const reject = node('button', 'btn small ghost', '拒绝'); reject.type = 'button';
      const approve = node('button', 'btn small primary', '批准并创建草稿'); approve.type = 'button';
      reject.addEventListener('click', async () => { await window.desktopPet.agent.reject(task.id); await refresh(); });
      approve.addEventListener('click', async () => { await window.desktopPet.agent.approve(task.id); await refresh(); });
      actions.append(reject, approve); item.appendChild(actions);
    }
    list.appendChild(item);
  }
}

function renderAudit(entries) {
  const list = $('auditList'); list.textContent = '';
  if (!Array.isArray(entries) || !entries.length) { list.appendChild(node('div', 'empty', '暂无审计记录')); return; }
  for (const entry of entries.slice(0, 30)) {
    const row = node('div', 'audit-row');
    row.append(node('span', '', entry.type), node('span', '', entry.capability || '—'), node('span', '', entry.state || '—'));
    list.appendChild(row);
  }
}

async function refresh() {
  const [status, tasks, audit] = await Promise.all([
    window.desktopPet.agent.getStatus(), window.desktopPet.agent.listTasks(), window.desktopPet.agent.listAudit(),
  ]);
  $('agentStatus').className = `agent-status${status?.ready ? ' ready' : ''}`;
  $('agentStatus').textContent = status?.ready ? `${status.provider}/${status.model}` : (status?.enabled ? '配置不完整' : '未启用');
  $('requestBtn').disabled = !status?.ready;
  renderTasks(tasks); renderAudit(audit);
}

async function requestDraft() {
  const description = $('draftRequest').value.trim();
  if (!description) return;
  $('requestBtn').disabled = true; $('requestHint').textContent = '正在生成提案…';
  try {
    await window.desktopPet.agent.requestDraft(description);
    $('draftRequest').value = ''; $('requestHint').textContent = '';
  } catch { $('requestHint').textContent = '提案生成失败'; }
  await refresh();
}

function init() {
  $('requestBtn').addEventListener('click', requestDraft);
  $('openDraftsBtn').addEventListener('click', () => window.desktopPet.agent.openDrafts());
  $('closeBtn').addEventListener('click', () => window.desktopPet.agent.closePanel());
  $('dragClose').addEventListener('click', () => window.desktopPet.agent.closePanel());
  $('backBtn').addEventListener('click', () => { window.desktopPet.agent.closePanel(); window.desktopPet.openSettingsCenter(); });
  void refresh();
  setInterval(() => { void refresh(); }, 3000);
}

init();
