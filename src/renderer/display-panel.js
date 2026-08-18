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

// —— P0-5：状态卡片 ——
// 阶段经验阈值（与 src/systems/pet-state.js 的 STAGES 一致）
const STAGE_THRESHOLDS = [
  { stage: '幼年', exp: 0 },
  { stage: '成长', exp: 100 },
  { stage: '成熟', exp: 300 },
];
const petPoll = { timer: null };

function stageProgress(exp) {
  let lo = 0, hi = 100;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) {
    if (exp >= STAGE_THRESHOLDS[i].exp) {
      if (i + 1 < STAGE_THRESHOLDS.length) { lo = STAGE_THRESHOLDS[i].exp; hi = STAGE_THRESHOLDS[i + 1].exp; }
      else { lo = STAGE_THRESHOLDS[i].exp; hi = STAGE_THRESHOLDS[i].exp + 1; }
    }
  }
  const toNext = hi - lo;
  return { label: `${lo}`, pct: toNext > 0 ? Math.min(100, Math.round(((exp - lo) / toNext) * 100)) : 100 };
}

async function renderPetState() {
  try {
    const s = await window.desktopPet.petState.get();
    if (!s || typeof s !== 'object') return;
    const e = s.emotion || {};
    $('sMood').textContent = `${e.mood || '—'} ${Math.round(e.moodScore ?? 0)}`;
    $('sAffection').textContent = `${Math.round((s.affection && s.affection.value) || 0)}`;
    $('sEnergy').textContent = Math.round(e.energy ?? 0);
    $('sStress').textContent = Math.round(e.stress ?? 0);
    $('sLoneliness').textContent = Math.round(e.loneliness ?? 0);
    $('sHealth').textContent = Math.round(e.health ?? 0);
    const stage = (s.nurture && s.nurture.stage) || '幼年';
    $('stageChip').textContent = stage;
    const exp = (s.nurture && s.nurture.experience) || 0;
    const sp = stageProgress(exp);
    $('stageExp').textContent = exp;
    $('stageLabel').textContent = stage === '成熟' ? '成长经验（已满）' : `成长经验（下一阶段 ${sp.label}）`;
    $('expFill').style.width = `${sp.pct}%`;
  } catch { /* 暂不可用则保持占位 */ }
}

function startPetPolling() {
  renderPetState();
  petPoll.timer = setInterval(renderPetState, 2000);
}

function stopPetPolling() {
  if (petPoll.timer) { clearInterval(petPoll.timer); petPoll.timer = null; }
}

// —— P1：生活感知（实时感知 + 今日日记） ——
const lifePoll = { timer: null };

async function renderSensing() {
  try {
    const r = await window.desktopPet.systemSense.get();
    if (!r) return;
    $('awareLine').textContent = r.awareness || '暂无有效感知数据';
  } catch { /* 保持占位 */ }
}

async function renderDiary() {
  try {
    const d = await window.desktopPet.diary.getToday();
    if (!d) return;
    $('diaryDate').textContent = `${d.date} 的日记`;
    if (d.exists && d.content) {
      $('diaryText').textContent = d.content.trim();
    } else {
      $('diaryText').textContent = '（今天还没有日记）';
    }
  } catch { /* 保持占位 */ }
}

async function generateDiary() {
  const button = $('diaryGenerateBtn');
  button.disabled = true;
  button.textContent = '写着…';
  try {
    const result = await window.desktopPet.diary.generateToday();
    if (!result?.ok) throw new Error(result?.error || 'failed');
    $('diaryDate').textContent = `${result.date} 的日记`;
    $('diaryText').textContent = result.content;
    showFeedback('日记写好了', `基于 ${result.sourceCount || 0} 条已保存记录`);
  } catch {
    showFeedback('暂时写不出来', '检查模型连接后再试一次', true);
  } finally {
    button.disabled = false;
    button.textContent = '写一页';
  }
}

function startLifePolling() {
  renderSensing();
  renderDiary();
  lifePoll.timer = setInterval(() => { renderSensing(); renderDiary(); }, 5000);
}

function stopLifePolling() {
  if (lifePoll.timer) { clearInterval(lifePoll.timer); lifePoll.timer = null; }
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeDisplayPanel());
  $('resetBtn').addEventListener('click', reset);
  $('diaryGenerateBtn').addEventListener('click', generateDiary);
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
  $('diaryOpenBtn').addEventListener('click', () => { window.desktopPet.diary.openFolder(); });

  try {
    const loaded = await window.desktopPet.display.get();
    if (loaded && typeof loaded === 'object') settings = loaded;
    render();
  } catch {
    showFeedback('读取失败', '暂时没读到显示设置', true);
  }
  startPetPolling();
  startLifePolling();
  window.addEventListener('unload', () => { stopPetPolling(); stopLifePolling(); });
}

init();
