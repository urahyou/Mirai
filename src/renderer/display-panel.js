const $ = (id) => document.getElementById(id);

let settings = { scale: 1, alwaysOnTop: true, outlineShadow: false, bubbleDuration: 0, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 };
let feedbackTimer = null;
let previewFrame = null;
let pendingScale = null;

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
  }, 2200);
}

function render() {
  const percentage = Math.round(settings.scale * 100);
  $('scaleRange').value = String(percentage);
  $('scaleRange').style.setProperty('--progress', `${((percentage - 70) / 80) * 100}%`);
  $('scaleValue').textContent = `${percentage}%`;
  $('alwaysOnTop').checked = settings.alwaysOnTop;
  $('outlineShadow').checked = settings.outlineShadow;
  $('bubbleRange').value = String(settings.bubbleDuration);
  $('bubbleRange').style.setProperty('--progress', `${(settings.bubbleDuration / 30) * 100}%`);
  $('bubbleValue').textContent = settings.bubbleDuration > 0 ? `${settings.bubbleDuration}s` : '自动';
  $('voiceDockAutoHide').checked = settings.voiceDockAutoHide;
  $('dockHideRange').value = String(settings.voiceDockAutoHideSec);
  $('dockHideRange').style.setProperty('--progress', `${((settings.voiceDockAutoHideSec - 3) / 27) * 100}%`);
  $('dockHideValue').textContent = `${settings.voiceDockAutoHideSec}s`;
  $('dockHideSecSection').style.opacity = settings.voiceDockAutoHide ? '1' : '0.5';
}

async function save(patch) {
  try {
    const saved = await window.desktopPet.display.set(patch);
    if (!saved || typeof saved !== 'object') throw new Error('invalid display settings response');
    settings = saved;
    render();
    showFeedback('已应用', '显示方式已经更新');
  } catch {
    render();
    showFeedback('保存失败', '显示设置没有更新，请再试一次', true);
  }
}

async function reset() {
  $('resetBtn').disabled = true;
  try {
    settings = await window.desktopPet.display.set({ scale: 1, alwaysOnTop: true, outlineShadow: false, bubbleDuration: 0, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 });
    render();
    showFeedback('已恢复默认', '小未来回到标准大小并重新置顶');
  } catch {
    showFeedback('恢复失败', '默认显示设置没有取回来', true);
  } finally {
    $('resetBtn').disabled = false;
  }
}

function previewScale(scale) {
  pendingScale = scale;
  if (previewFrame !== null) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = null;
    const nextScale = pendingScale;
    pendingScale = null;
    if (nextScale !== null) window.desktopPet.display.preview({ scale: nextScale }).catch(() => {});
  });
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeDisplayPanel());
  $('resetBtn').addEventListener('click', reset);
  $('scaleRange').addEventListener('input', () => {
    const scale = Number($('scaleRange').value) / 100;
    $('scaleValue').textContent = `${$('scaleRange').value}%`;
    $('scaleRange').style.setProperty('--progress', `${((scale * 100 - 70) / 80) * 100}%`);
    previewScale(scale);
  });
  $('scaleRange').addEventListener('change', () => save({ scale: Number($('scaleRange').value) / 100 }));
  $('alwaysOnTop').addEventListener('change', () => save({ alwaysOnTop: $('alwaysOnTop').checked }));
  $('outlineShadow').addEventListener('change', () => save({ outlineShadow: $('outlineShadow').checked }));
  $('voiceDockAutoHide').addEventListener('change', () => save({ voiceDockAutoHide: $('voiceDockAutoHide').checked }));
  $('bubbleRange').addEventListener('input', () => {
    const v = Number($('bubbleRange').value);
    $('bubbleValue').textContent = v > 0 ? `${v}s` : '自动';
    $('bubbleRange').style.setProperty('--progress', `${(v / 30) * 100}%`);
  });
  $('bubbleRange').addEventListener('change', () => save({ bubbleDuration: Number($('bubbleRange').value) }));
  $('dockHideRange').addEventListener('input', () => {
    const v = Number($('dockHideRange').value);
    $('dockHideValue').textContent = `${v}s`;
    $('dockHideRange').style.setProperty('--progress', `${((v - 3) / 27) * 100}%`);
  });
  $('dockHideRange').addEventListener('change', () => save({ voiceDockAutoHideSec: Number($('dockHideRange').value) }));

  try {
    const loaded = await window.desktopPet.display.get();
    if (loaded && typeof loaded === 'object') settings = loaded;
    render();
  } catch {
    showFeedback('读取失败', '暂时没读到显示设置', true);
  }
}

init();
