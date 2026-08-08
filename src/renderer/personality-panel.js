const $ = (id) => document.getElementById(id);

let feedbackTimer = null;

function text(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
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

function renderPersonality(data) {
  const record = data && typeof data === 'object' ? data : {};
  const personality = record.personality && typeof record.personality === 'object' ? record.personality : {};
  $('personalityName').value = text(record.name);
  $('personalityMood').value = text(personality.mood);
  $('personalityAge').value = text(personality.age);
  $('personalityLikes').value = joinList(personality.likes);
  $('personalityDislikes').value = joinList(personality.dislikes);
  $('personalityCatchphrases').value = joinList(personality.catchphrases);
  $('personalityTone').value = text(personality.tone);
  $('personalitySelfIntro').value = text(personality.selfIntro);
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

function readPatch() {
  return {
    name: $('personalityName').value.trim(),
    personality: {
      mood: $('personalityMood').value.trim(),
      age: $('personalityAge').value.trim(),
      likes: splitList($('personalityLikes').value),
      dislikes: splitList($('personalityDislikes').value),
      catchphrases: splitList($('personalityCatchphrases').value),
      tone: $('personalityTone').value.trim(),
      selfIntro: $('personalitySelfIntro').value.trim(),
    },
  };
}

async function savePersonality() {
  const saveButton = $('saveBtn');
  saveButton.disabled = true;
  try {
    const patch = readPatch();
    const saved = await window.desktopPet.personality.set(patch);
    const refreshed = await window.desktopPet.personality.get();
    renderPersonality(refreshed || saved || {});
    showFeedback('已保存', '诶嘿，这就是现在的我啦~');
  } catch {
    showFeedback('保存失败', '这次没有改好，再试一次吧', true);
  } finally {
    saveButton.disabled = false;
  }
}

async function resetPersonality() {
  const resetButton = $('resetBtn');
  resetButton.disabled = true;
  try {
    const restored = await window.desktopPet.personality.reset();
    renderPersonality(restored || {});
    showFeedback('已恢复默认', '小未来回到最初的模样啦~');
  } catch {
    showFeedback('恢复失败', '默认设定没有取回来，再试一次吧', true);
  } finally {
    resetButton.disabled = false;
  }
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closePersonalityPanel());
  $('resetBtn').addEventListener('click', resetPersonality);
  $('personalityForm').addEventListener('submit', (event) => {
    event.preventDefault();
    savePersonality();
  });
  try {
    const personality = await window.desktopPet.personality.get();
    renderPersonality(personality || {});
  } catch {
    showFeedback('读取失败', '暂时没读到性格设定，请稍后再试', true);
  }
}

init();
