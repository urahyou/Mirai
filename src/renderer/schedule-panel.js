const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
  reminder: '一次提醒',
  deadline: '截止',
  proactive: '主动',
};
const REPEAT_LABELS = {
  daily: '每日',
  weekly: '每周',
};

let schedules = [];

function flash(text, isError = false) {
  const node = $('saveHint');
  node.textContent = text;
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  setTimeout(() => { node.textContent = ''; }, 2200);
}

function flashForm(text, isError = false) {
  const node = $('formHint');
  node.textContent = text;
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  setTimeout(() => { node.textContent = ''; }, 2200);
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function renderSchedules() {
  const list = $('scheduleList');
  list.innerHTML = '';
  $('scheduleEmpty').style.display = schedules.length ? 'none' : 'block';

  for (const schedule of schedules) {
    const row = document.createElement('div');
    row.className = 'schedule-item' + (schedule.enabled ? '' : ' disabled');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'schedule-toggle';
    toggle.checked = schedule.enabled === true;
    toggle.addEventListener('change', async () => {
      await window.desktopPet.schedule.update(schedule.id, { enabled: toggle.checked });
      await refresh();
    });

    const main = document.createElement('div');
    main.className = 'schedule-main';

    const title = document.createElement('div');
    title.className = 'schedule-title';
    title.textContent = schedule.title;

    const meta = document.createElement('div');
    meta.className = 'schedule-meta';
    const time = document.createElement('span');
    time.textContent = formatTime(schedule.runAt);
    const type = document.createElement('span');
    type.className = 'schedule-type';
    type.textContent = TYPE_LABELS[schedule.type] || schedule.type;
    meta.append(time, type);
    if (schedule.repeat) {
      const badge = document.createElement('span');
      badge.className = 'schedule-repeat';
      badge.textContent = REPEAT_LABELS[schedule.repeat.interval] || schedule.repeat.interval;
      meta.appendChild(badge);
    }
    if (schedule.note) {
      const note = document.createElement('span');
      note.textContent = schedule.note;
      meta.appendChild(note);
    }
    main.append(title, meta);

    const del = document.createElement('button');
    del.className = 'schedule-del';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      await window.desktopPet.schedule.remove(schedule.id);
      await refresh();
    });

    row.append(toggle, main, del);
    list.appendChild(row);
  }
}

async function refresh() {
  schedules = (await window.desktopPet.schedule.list({ includeDisabled: true })) || [];
  renderSchedules();
}

async function handleCreate() {
  const title = $('inputTitle').value.trim();
  const runAt = $('inputRunAt').value;
  if (!title) {
    flashForm('请填写提醒内容', true);
    return;
  }
  if (!runAt) {
    flashForm('请选择提醒时间', true);
    return;
  }
  const repeat = $('inputRepeat').value;
  const input = {
    title,
    runAt: new Date(runAt).toISOString(),
    type: $('inputType').value,
    note: $('inputNote').value.trim(),
    repeat: repeat ? { interval: repeat } : null,
  };
  const created = await window.desktopPet.schedule.create(input);
  if (!created) {
    flashForm('添加失败，请检查输入', true);
    return;
  }
  $('inputTitle').value = '';
  $('inputRunAt').value = '';
  $('inputNote').value = '';
  flashForm('已添加');
  await refresh();
}

function bindEvents() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeSchedulePanel());
  $('createBtn').addEventListener('click', handleCreate);
  $('clearAllBtn').addEventListener('click', async () => {
    if (confirm('确定要清空全部提醒吗？此操作不可恢复。')) {
      await window.desktopPet.schedule.clear();
      await refresh();
      flash('已清空全部提醒');
    }
  });
}

async function init() {
  bindEvents();
  await refresh();
}

init();