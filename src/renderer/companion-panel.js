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

async function renderSensing() {
  try {
    const r = await window.desktopPet.systemSense.get();
    if (!r) return;
    const b = (r.snapshot && r.snapshot.battery) || {};
    const bits = [r.awareness || '—'];
    if (typeof b.level === 'number') bits.push(`电量 ${b.level}%（${b.charging ? '充电中' : '使用中'}）`);
    $('awareLine').textContent = bits.join(' · ');
  } catch {}
}

function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeCompanionPanel());
  $('dragClose')?.addEventListener('click', () => window.desktopPet.closeCompanionPanel());
  $('backBtn').addEventListener('click', () => { window.desktopPet.closeCompanionPanel(); window.desktopPet.openSettingsCenter(); });
  $('diaryOpenBtn').addEventListener('click', () => window.desktopPet.diary.openPanel());
  renderPetState(); renderSensing();
  setInterval(() => { renderPetState(); renderSensing(); }, 5000);
}

init();
