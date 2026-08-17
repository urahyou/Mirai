// 桌面行为面板：始终置顶 / 扇形面板自动收起。
const $ = (id) => document.getElementById(id);

let feedbackTimer = null;
let settings = { alwaysOnTop: true, voiceDockAutoHide: true, voiceDockAutoHideSec: 6 };
let initiative = { enabled: true, quietStartHour: 23, quietEndHour: 8, dailyBudget: 3 };

function showFeedback(status) {
  const hintNode = $('saveHint');
  clearTimeout(feedbackTimer);
  hintNode.textContent = status;
  feedbackTimer = setTimeout(() => { hintNode.textContent = ''; }, 2000);
}

function render() {
  $('alwaysOnTop').checked = settings.alwaysOnTop;
  $('voiceDockAutoHide').checked = settings.voiceDockAutoHide;
  $('dockHideRange').value = String(settings.voiceDockAutoHideSec);
  $('dockHideRange').style.setProperty('--progress', `${((settings.voiceDockAutoHideSec - 3) / 27) * 100}%`);
  $('dockHideValue').textContent = `${settings.voiceDockAutoHideSec}s`;
  $('dockHideSecSection').style.opacity = settings.voiceDockAutoHide ? '1' : '0.5';
  $('initiativeEnabled').checked = initiative.enabled;
  $('quietStartHour').value = String(initiative.quietStartHour);
  $('quietEndHour').value = String(initiative.quietEndHour);
  $('dailyBudget').value = String(initiative.dailyBudget);
  $('initiativeRules').style.opacity = initiative.enabled ? '1' : '0.5';
}

async function save(patch) {
  try {
    const saved = await window.desktopPet.display.set(patch);
    if (!saved || typeof saved !== 'object') throw new Error('invalid response');
    settings = saved; render(); showFeedback('已保存');
  } catch { showFeedback('保存失败，请再试'); }
}

async function saveInitiative(patch) {
  try {
    const saved = await window.desktopPet.initiative.set(patch);
    if (!saved || typeof saved !== 'object') throw new Error('invalid response');
    initiative = saved; render(); showFeedback('已保存');
  } catch { showFeedback('保存失败，请再试'); }
}

function fillHourOptions() {
  for (const id of ['quietStartHour', 'quietEndHour']) {
    const select = $(id);
    for (let hour = 0; hour < 24; hour += 1) {
      const option = document.createElement('option');
      option.value = String(hour); option.textContent = `${String(hour).padStart(2, '0')}:00`;
      select.appendChild(option);
    }
  }
}

async function init() {
  fillHourOptions();
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeBehaviorPanel());
  $('dragClose')?.addEventListener('click', () => window.desktopPet.closeBehaviorPanel());
  $('backBtn').addEventListener('click', () => { window.desktopPet.closeBehaviorPanel(); window.desktopPet.openSettingsCenter(); });
  $('alwaysOnTop').addEventListener('change', () => save({ alwaysOnTop: $('alwaysOnTop').checked }));
  $('voiceDockAutoHide').addEventListener('change', () => save({ voiceDockAutoHide: $('voiceDockAutoHide').checked }));
  $('dockHideRange').addEventListener('input', () => {
    const v = Number($('dockHideRange').value);
    $('dockHideValue').textContent = `${v}s`;
    $('dockHideRange').style.setProperty('--progress', `${((v - 3) / 27) * 100}%`);
  });
  $('dockHideRange').addEventListener('change', () => save({ voiceDockAutoHideSec: Number($('dockHideRange').value) }));
  $('initiativeEnabled').addEventListener('change', () => saveInitiative({ enabled: $('initiativeEnabled').checked }));
  $('quietStartHour').addEventListener('change', () => saveInitiative({ quietStartHour: Number($('quietStartHour').value) }));
  $('quietEndHour').addEventListener('change', () => saveInitiative({ quietEndHour: Number($('quietEndHour').value) }));
  $('dailyBudget').addEventListener('change', () => saveInitiative({ dailyBudget: Number($('dailyBudget').value) }));

  try {
    const loaded = await window.desktopPet.display.get();
    if (loaded && typeof loaded === 'object') settings = loaded;
  } catch {}
  try {
    const loadedInitiative = await window.desktopPet.initiative.get();
    if (loadedInitiative && typeof loadedInitiative === 'object') initiative = loadedInitiative;
  } catch {}
  render();
}

init();
