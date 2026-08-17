// 外观面板：角色大小 / 轮廓阴影 / 气泡时长。
const $ = (id) => document.getElementById(id);

let feedbackTimer = null;
let previewFrame = null;
let pendingScale = null;
let settings = { scale: 1, outlineShadow: false, bubbleDuration: 0 };

function showFeedback(status, hint, isError = false) {
  const hintNode = $('saveHint');
  clearTimeout(feedbackTimer);
  hintNode.textContent = status;
  hintNode.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  feedbackTimer = setTimeout(() => { hintNode.textContent = hint; }, 2000);
}

function render() {
  const percentage = Math.round(settings.scale * 100);
  $('scaleRange').value = String(percentage);
  $('scaleRange').style.setProperty('--progress', `${((percentage - 70) / 80) * 100}%`);
  $('scaleValue').textContent = `${percentage}%`;
  $('outlineShadow').checked = settings.outlineShadow;
  $('bubbleRange').value = String(settings.bubbleDuration);
  $('bubbleRange').style.setProperty('--progress', `${(settings.bubbleDuration / 30) * 100}%`);
  $('bubbleValue').textContent = settings.bubbleDuration > 0 ? `${settings.bubbleDuration}s` : '自动';
}

async function save(patch) {
  try {
    const saved = await window.desktopPet.display.set(patch);
    if (!saved || typeof saved !== 'object') throw new Error('invalid response');
    settings = saved; render(); showFeedback('已保存', '', false);
  } catch { showFeedback('保存失败，请再试', '', true); }
}

function previewScale(scale) {
  pendingScale = scale;
  if (previewFrame !== null) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = null;
    const next = pendingScale; pendingScale = null;
    if (next !== null) window.desktopPet.display.preview({ scale: next }).catch(() => {});
  });
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeAppearancePanel());
  $('backBtn').addEventListener('click', () => { window.desktopPet.closeAppearancePanel(); window.desktopPet.openSettingsCenter(); });
  $('scaleRange').addEventListener('input', () => {
    const scale = Number($('scaleRange').value) / 100;
    $('scaleValue').textContent = `${$('scaleRange').value}%`;
    $('scaleRange').style.setProperty('--progress', `${((scale * 100 - 70) / 80) * 100}%`);
    previewScale(scale);
  });
  $('scaleRange').addEventListener('change', () => save({ scale: Number($('scaleRange').value) / 100 }));
  $('outlineShadow').addEventListener('change', () => save({ outlineShadow: $('outlineShadow').checked }));
  $('bubbleRange').addEventListener('input', () => {
    const v = Number($('bubbleRange').value);
    $('bubbleValue').textContent = v > 0 ? `${v}s` : '自动';
    $('bubbleRange').style.setProperty('--progress', `${(v / 30) * 100}%`);
  });
  $('bubbleRange').addEventListener('change', () => save({ bubbleDuration: Number($('bubbleRange').value) }));

  try {
    const loaded = await window.desktopPet.display.get();
    if (loaded && typeof loaded === 'object') settings = loaded;
  } catch {}
  render();
}

init();
