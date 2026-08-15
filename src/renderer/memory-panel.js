const $ = (id) => document.getElementById(id);
const keys = ['GRAPHITI_ENABLED', 'GRAPHITI_BASE_URL', 'GRAPHITI_GROUP_ID', 'GRAPHITI_NEO4J_URI', 'GRAPHITI_NEO4J_USER', 'GRAPHITI_NEO4J_PASSWORD', 'GRAPHITI_NEO4J_DATABASE', 'GRAPHITI_LLM_BASE_URL', 'GRAPHITI_LLM_MODEL', 'GRAPHITI_EMBED_BASE_URL', 'GRAPHITI_EMBED_MODEL', 'GRAPHITI_LLM_API_KEY'];
let settings = {};

function feedback(text, error = false) {
  const node = $('saveStatus');
  node.textContent = text;
  node.style.color = error ? 'var(--danger)' : 'var(--muted)';
  setTimeout(() => { node.textContent = ''; }, 2400);
}

function setForm(data) {
  settings = { ...data };
  for (const key of keys) {
    const node = $(key);
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = ['1', 'true', 'yes', 'on'].includes(String(data[key]).toLowerCase());
    else {
      node.value = data[key] === 'configured' ? '' : String(data[key] || '');
      if (data[key] === 'configured') node.placeholder = '已配置（留空保持不变）';
    }
  }
}

function getFormPatch() {
  const patch = {};
  for (const key of keys) {
    const node = $(key);
    if (!node) continue;
    if (node.type === 'checkbox') patch[key] = node.checked ? 'true' : 'false';
    else if (node.value.trim()) patch[key] = node.value.trim();
  }
  return patch;
}

async function refreshStatus() {
  const box = $('statusBox');
  try {
    const status = await window.desktopPet.memory.getStatus();
    box.className = `status ${status?.ok ? 'ok' : 'bad'}`;
    const state = status?.state || (status?.enabled ? 'unreachable' : 'disabled');
    box.innerHTML = `<b>Graphiti：${status?.enabled ? '已启用' : '未启用'}</b><br>Sidecar：${state}<br>地址：${status?.baseUrl || ''}${status?.error ? `<br>错误：${status.error}` : ''}`;
  } catch (error) {
    box.className = 'status bad';
    box.textContent = `无法读取 Graphiti 状态：${error.message || error}`;
  }
}

async function load() {
  try {
    setForm(await window.desktopPet.memory.getSettings());
    await refreshStatus();
  } catch (error) {
    feedback(`加载失败：${error.message || error}`, true);
  }
}

$('saveBtn').addEventListener('click', async () => {
  try {
    const patch = getFormPatch();
    await window.desktopPet.memory.setSettings(patch);
    feedback('Graphiti 配置已保存');
    await load();
  } catch (error) { feedback(`保存失败：${error.message || error}`, true); }
});
$('checkBtn').addEventListener('click', refreshStatus);
$('closeBtn').addEventListener('click', () => window.desktopPet.memory.closePanel());
load();
