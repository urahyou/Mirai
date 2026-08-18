// 与小未来相处面板：状态 / 喂养说明 / 感知 / 今日日记。
const $ = (id) => document.getElementById(id);

const STAGE_THRESHOLDS = [
  { stage: '幼年', exp: 0 },
  { stage: '成长', exp: 100 },
  { stage: '成熟', exp: 300 },
];

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
  } catch {}
}

function perceptionLabel(item) {
  if (item.id === 'system') return '系统状态';
  if (item.id === 'weather') return '天气';
  if (item.id === 'screen') return '屏幕观察';
  return item.label || item.id;
}

function weatherLocationControls(item) {
  const row = document.createElement('div');
  row.className = 'weather-location';
  const latitude = document.createElement('input');
  latitude.type = 'number'; latitude.step = '0.0001'; latitude.placeholder = '纬度'; latitude.min = '-90'; latitude.max = '90';
  const longitude = document.createElement('input');
  longitude.type = 'number'; longitude.step = '0.0001'; longitude.placeholder = '经度'; longitude.min = '-180'; longitude.max = '180';
  const save = document.createElement('button');
  save.className = 'btn tiny ghost'; save.type = 'button'; save.textContent = '保存位置';
  const clear = document.createElement('button');
  clear.className = 'btn tiny ghost'; clear.type = 'button'; clear.textContent = '清除位置';
  window.desktopPet.weather.get().then((value) => {
    if (typeof value?.latitude === 'number') latitude.value = String(value.latitude);
    if (typeof value?.longitude === 'number') longitude.value = String(value.longitude);
  }).catch(() => {});
  save.addEventListener('click', async () => {
    if (!latitude.value.trim() || !longitude.value.trim()) return;
    const patch = { latitude: Number(latitude.value), longitude: Number(longitude.value) };
    try { await window.desktopPet.weather.set(patch); await renderPerceptionSettings(); } catch {}
  });
  clear.addEventListener('click', async () => {
    try { await window.desktopPet.weather.set({ latitude: null, longitude: null }); await renderPerceptionSettings(); } catch {}
  });
  row.append(latitude, longitude, save, clear);
  return row;
}

function renderPerceptions(items) {
  const root = $('perceptionList');
  root.textContent = '';
  for (const item of Array.isArray(items) ? items : []) {
    const row = document.createElement('div');
    row.className = 'perception-item';
    const text = document.createElement('div');
    text.className = 'perception-copy';
    const title = document.createElement('strong');
    title.textContent = perceptionLabel(item);
    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = item.permission === 'not-configured' ? '需先填写位置' : (item.available ? (item.stale ? '数据已过期' : (item.hasData ? '数据有效' : '等待首次采集')) : '当前不可用');
    text.append(title, meta);
    const controls = document.createElement('div');
    controls.className = 'perception-controls';
    const toggle = document.createElement('input');
    const unavailable = !item.available || item.permission === 'not-configured';
    toggle.type = 'checkbox'; toggle.checked = Boolean(item.enabled); toggle.disabled = unavailable;
    toggle.addEventListener('change', async () => {
      try { await window.desktopPet.perception.set(item.id, { enabled: toggle.checked }); await renderPerceptionSettings(); } catch { toggle.checked = !toggle.checked; }
    });
    const ttl = document.createElement('select');
    for (const [seconds, label] of [[60, '1 分钟'], [300, '5 分钟'], [900, '15 分钟'], [1800, '30 分钟'], [3600, '1 小时'], [86400, '24 小时']]) {
      const option = document.createElement('option'); option.value = String(seconds); option.textContent = `${label}有效`;
      ttl.appendChild(option);
    }
    ttl.value = String(item.ttlSeconds); ttl.disabled = unavailable;
    ttl.addEventListener('change', async () => { await window.desktopPet.perception.set(item.id, { ttlSeconds: Number(ttl.value) }); await renderPerceptionSettings(); });
    const clear = document.createElement('button');
    clear.className = 'btn tiny ghost'; clear.type = 'button'; clear.textContent = '清除'; clear.disabled = !item.hasData;
    clear.addEventListener('click', async () => { await window.desktopPet.perception.clear(item.id); await renderPerceptionSettings(); });
    controls.append(toggle, ttl, clear);
    row.append(text, controls);
    root.appendChild(row);
    if (item.id === 'weather') root.appendChild(weatherLocationControls(item));
  }
}

async function renderPerceptionSettings() {
  try { renderPerceptions(await window.desktopPet.perception.list()); } catch { renderPerceptions([]); }
}

async function renderSensing() {
  try {
    const r = await window.desktopPet.systemSense.get();
    if (!r) return;
    $('awareLine').textContent = r.awareness || '暂无有效感知数据';
  } catch {}
}

function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeCompanionPanel());
  $('dragClose')?.addEventListener('click', () => window.desktopPet.closeCompanionPanel());
  $('backBtn').addEventListener('click', () => { window.desktopPet.closeCompanionPanel(); window.desktopPet.openSettingsCenter(); });
  $('diaryOpenBtn').addEventListener('click', () => window.desktopPet.diary.openPanel());
  renderPetState(); renderSensing(); renderPerceptionSettings();
  setInterval(() => { renderPetState(); renderSensing(); renderPerceptionSettings(); }, 5000);
}

init();
