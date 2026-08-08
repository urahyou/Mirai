const $ = (id) => document.getElementById(id);

let feedbackTimer = null;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function splitList(value) {
  return text(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function joinList(value) {
  return list(value).join(', ');
}

function renderOwner(owner) {
  const data = owner && typeof owner === 'object' ? owner : {};
  $('ownerName').value = text(data.name);
  $('ownerBirthday').value = text(data.birthday);
  $('ownerLikes').value = joinList(data.likes);
  $('ownerNote').value = text(data.note);
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

function readOwner() {
  return {
    name: $('ownerName').value.trim(),
    birthday: $('ownerBirthday').value.trim(),
    likes: splitList($('ownerLikes').value),
    note: $('ownerNote').value.trim(),
  };
}

async function saveOwner() {
  const saveButton = $('saveBtn');
  saveButton.disabled = true;
  try {
    const saved = await window.desktopPet.owner.set(readOwner());
    renderOwner(saved || readOwner());
    showFeedback('已保存', '诶嘿，记住啦~');
  } catch {
    showFeedback('保存失败', '这次没有记住，再试一次吧', true);
  } finally {
    saveButton.disabled = false;
  }
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeOwnerPanel());
  $('ownerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    saveOwner();
  });
  try {
    const owner = await window.desktopPet.owner.get();
    renderOwner(owner || {});
  } catch {
    showFeedback('读取失败', '暂时没读到资料，请稍后再试', true);
  }
}

init();
