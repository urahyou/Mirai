const $ = (id) => document.getElementById(id);

const APP_TOGGLES = [
  ['optNotifications', 'notifications'],
  ['optSound', 'sound'],
  ['optAnimation', 'animation'],
  ['optReduceMotion', 'reduceMotion'],
  ['optNetwork', 'networkConsent'],
  ['optMemorySaving', 'memorySaving'],
];

let app = {};
let proactive = {};

function flash(text, isError = false) {
  const node = $('saveHint');
  node.textContent = text;
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  setTimeout(() => { node.textContent = ''; }, 2200);
}

function renderProactive() {
  const paused = proactive.pausedUntil && new Date(proactive.pausedUntil).getTime() > Date.now();
  $('proactiveEnabled').checked = proactive.enabled === true;
  $('pauseHint').textContent = paused
    ? `已暂停至 ${new Date(proactive.pausedUntil).toLocaleTimeString()}`
    : `每小时 ${proactive.hourlyBudget || 0} 次，每天 ${proactive.dailyBudget || 0} 次`;
}

function renderAppToggles() {
  for (const [boxId, key] of APP_TOGGLES) {
    $(boxId).checked = app[key] === true;
  }
}

function renderMemSummary() {
  const el = $('memSummary');
  if (!el) return;
  el.textContent = '正在读取…';
  window.desktopPet.memory.stats().then((s) => {
    const c = s && s.counts;
    if (!c) return;
    el.textContent = `常驻 ${c.core} · 活跃 ${c.active} · 已归档 ${c.archived} · 回收站 ${c.trash}`;
  }).catch(() => { el.textContent = ''; });
}

async function refresh() {
  const [p, s] = await Promise.all([
    window.desktopPet.proactive.get(),
    window.desktopPet.settings.get(),
  ]);
  proactive = p || {};
  app = s || {};
  renderProactive();
  renderAppToggles();
  renderMemSummary();
}

function bindProactive() {
  $('proactiveEnabled').addEventListener('change', async (e) => {
    proactive = await window.desktopPet.proactive.set({ enabled: e.target.checked });
    renderProactive();
    flash('已保存');
  });
  $('pauseBtn').addEventListener('click', async () => {
    proactive = await window.desktopPet.proactive.pause(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    renderProactive();
    flash('已暂停主动搭话');
  });
  $('resumeBtn').addEventListener('click', async () => {
    proactive = await window.desktopPet.proactive.resume();
    renderProactive();
    flash('已恢复');
  });
}

function bindAppToggles() {
  for (const [boxId, key] of APP_TOGGLES) {
    $(boxId).addEventListener('change', async () => {
      app[key] = $(boxId).checked;
      app = await window.desktopPet.settings.set(app);
      flash('已保存');
    });
  }
}

function bindMemory() {
  const openBtn = $('openMemoryBtn');
  if (openBtn) openBtn.addEventListener('click', () => window.desktopPet.openMemoryPanel());
  $('exportBtn').addEventListener('click', async () => {
    const data = await window.desktopPet.memory.export();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xiaoweilai-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeSettings());
  bindProactive();
  bindAppToggles();
  bindMemory();
  await refresh();
}

init();
