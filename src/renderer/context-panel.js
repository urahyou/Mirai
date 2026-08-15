const $ = (id) => document.getElementById(id);

let settings = { maxContextTokens: 4096, modelMaxTokens: null };
let probing = false;
let feedbackTimer = null;

function fmtK(v) {
  const n = Number(v) || 0;
  // 按 1024 进制显示（131072 -> 128K），符合上下文窗口惯例
  const k = n / 1024;
  if (k >= 1000) return `${(k / 1024).toFixed(1)}M`;
  if (k >= 100) return `${Math.round(k)}K`;
  // 尽可能是整数（4K），否则保留 1 位小数（0.5K）
  const rounded = Math.round(k * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}K`;
}

function showFeedback(status, hint, isError = false) {
  const statusNode = $('saveStatus');
  const hintNode = $('saveHint');
  clearTimeout(feedbackTimer);
  statusNode.textContent = status;
  statusNode.classList.remove('show');
  requestAnimationFrame(() => statusNode.classList.add('show'));
  hintNode.textContent = hint;
  hintNode.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  feedbackTimer = setTimeout(() => {
    statusNode.classList.remove('show');
    hintNode.textContent = '';
  }, 2400);
}

function getUpper() {
  const m = Number(settings.modelMaxTokens);
  if (Number.isFinite(m) && m > 0) return Math.max(m, 1000);
  return 131072; // 未探测到上限时的软上限 128k
}

function render() {
  const upper = getUpper();
  const min = 1000;
  const range = $('contextRange');
  range.min = String(min);
  range.max = String(upper);
  range.step = '1000';
  range.value = String(settings.maxContextTokens);
  const pct = ((settings.maxContextTokens - min) / (upper - min)) * 100;
  range.style.setProperty('--progress', `${Math.max(0, Math.min(100, pct))}%`);
  $('contextValue').textContent = fmtK(settings.maxContextTokens);
  $('minLabel').textContent = fmtK(min);
  $('maxLabel').textContent = fmtK(upper);

  const badge = $('modelBadge');
  const probeHint = $('probeHint');
  if (Number.isFinite(settings.modelMaxTokens) && settings.modelMaxTokens > 0) {
    badge.textContent = `模型上限 ${fmtK(settings.modelMaxTokens)}`;
    badge.classList.remove('unknown');
    probeHint.textContent = `已自动探测到当前模型的上下文上限，滑条最大到此值。`;
  } else {
    badge.textContent = '未检出上限';
    badge.classList.add('unknown');
    probeHint.textContent = '未能自动探测模型上限（部分后端不暴露该信息），已用 128K 作为滑条上限，你可手动调到合适的值。';
  }
}

async function save(patch) {
  try {
    const saved = await window.desktopPet.context.set(patch);
    if (!saved || typeof saved !== 'object') throw new Error('invalid context settings response');
    settings.maxContextTokens = saved.maxContextTokens;
    render();
    showFeedback('已应用', '上下文窗口已经更新（仅影响新对话）');
  } catch {
    render();
    showFeedback('保存失败', '上下文设置没有更新，请再试一次', true);
  }
}

async function probe() {
  if (probing) return;
  probing = true;
  $('probeBtn').disabled = true;
  $('modelBadge').textContent = '探测中…';
  try {
    const modelMax = await window.desktopPet.context.probe();
    settings.modelMaxTokens = Number(modelMax) && modelMax > 0 ? modelMax : null;
    if (settings.maxContextTokens > getUpper()) settings.maxContextTokens = getUpper();
    render();
    showFeedback('已探测', modelMax ? '成功读取模型上下文上限' : '后端未提供上限信息');
  } catch {
    showFeedback('探测失败', '无法连接当前模型', true);
  } finally {
    probing = false;
    $('probeBtn').disabled = false;
  }
}

async function reset() {
  $('resetBtn').disabled = true;
  try {
    settings = await window.desktopPet.context.set({ maxContextTokens: 4096 });
    render();
    showFeedback('已恢复默认', '上下文窗口恢复为 4K');
  } catch {
    showFeedback('恢复失败', '默认上下文取值失败', true);
  } finally {
    $('resetBtn').disabled = false;
  }
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeContextPanel());
  $('probeBtn').addEventListener('click', probe);
  $('resetBtn').addEventListener('click', reset);
  $('contextRange').addEventListener('input', () => {
    const v = Number($('contextRange').value);
    $('contextValue').textContent = fmtK(v);
    const upper = getUpper(), min = 1000;
    $('contextRange').style.setProperty('--progress', `${((v - min) / (upper - min)) * 100}%`);
  });
  $('contextRange').addEventListener('change', () => {
    save({ maxContextTokens: Number($('contextRange').value) });
  });

  try {
    const loaded = await window.desktopPet.context.get();
    if (loaded && typeof loaded === 'object') {
      settings.maxContextTokens = loaded.maxContextTokens;
      settings.modelMaxTokens = loaded.modelMaxTokens || null;
    }
    render();
  } catch {
    showFeedback('读取失败', '暂时没读到上下文设置', true);
  }
}

init();
