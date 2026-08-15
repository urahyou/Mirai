const $ = (id) => document.getElementById(id);

let feedbackTimer = null;

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
  }, 2600);
}

function render(env) {
  $('speakLang').value = env.SIDECAR_TTS_SPEAK_LANG || '';
  $('ttsEngine').value = env.SIDECAR_TTS_ENGINE || 'edge';
  const isClone = env.SIDECAR_TTS_ENGINE === 'gpt-sovits';
  $('refNote').textContent = isClone
    ? `当前克隆参考音频：${env.SIDECAR_TTS_REF_WAV || '（未设置）'}${env.SIDECAR_TTS_PROMPT_TEXT ? '（台词：' + env.SIDECAR_TTS_PROMPT_TEXT.slice(0, 24) + '…）' : ''}。需先启动 GPT-SoVITS：bash ~/GPT-SoVITS/start_mac_api.sh`
    : 'Edge 使用云端音色，无需额外服务，但需联网。';
}

async function save(patch) {
  try {
    const env = await window.desktopPet.voiceSettings.set(patch);
    if (!env || typeof env !== 'object') throw new Error('invalid voice settings response');
    render(env);
    showFeedback('已应用', '语音设置已更新' + (patch.SIDECAR_TTS_ENGINE ? '（音色变更已即时生效）' : ''));
  } catch {
    showFeedback('保存失败', '语音设置没有更新，请再试一次', true);
  }
}

async function reset() {
  $('resetBtn').disabled = true;
  try {
    const env = await window.desktopPet.voiceSettings.set({ SIDECAR_TTS_ENGINE: 'edge', SIDECAR_TTS_SPEAK_LANG: '' });
    render(env);
    showFeedback('已恢复默认', '已切回 Edge 云端音色、跟随回复中文发音');
  } catch {
    showFeedback('恢复失败', '没有恢复到默认语音设置', true);
  } finally {
    $('resetBtn').disabled = false;
  }
}

async function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeVoiceSettingsPanel());
  $('resetBtn').addEventListener('click', reset);
  $('speakLang').addEventListener('change', () => save({ SIDECAR_TTS_SPEAK_LANG: $('speakLang').value }));
  $('ttsEngine').addEventListener('change', () => save({ SIDECAR_TTS_ENGINE: $('ttsEngine').value }));

  try {
    const env = await window.desktopPet.voiceSettings.get();
    if (env && typeof env === 'object') render(env);
  } catch {
    showFeedback('读取失败', '暂时没读到语音设置', true);
  }
}

init();
