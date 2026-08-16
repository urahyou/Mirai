// 语音设置子系统（L3）：读写 .env 的 SIDECAR_TTS_*（单一事实源 = .env，与侧车读到的一致）。
// 非「输出开关」配置变更需重启侧车让新音色/语言/延迟立即生效。
const IPC = require('../contracts/ipc');
const { guarded } = require('../main/ipc-validation');

module.exports = function setup({ ipcMain, voiceEnv, state, voiceBridge, voice, panels }) {
  ipcMain.handle(IPC.VoiceSettingsGet, () => voiceEnv.read());
  ipcMain.handle(IPC.VoiceSettingsSet, guarded(IPC.VoiceSettingsSet, (patch) => {
    const p = { ...patch };
    // 合成语言(text_lang)必须与引擎匹配：
    //  - 克隆引擎(gpt-sovits/qwen3)是单语言参考，中文参考恒中文直读，绝不随 speakLang 联动——
    //    否则会用中文参考按外语发音规则去读中文，出现“既不像中文也不像外语”的串扰。
    //  - 仅云端多语言 edge 引擎才允许 speakLang 联动合成语言（外语朗读）。
    const engine = typeof p.SIDECAR_TTS_ENGINE === 'string' ? p.SIDECAR_TTS_ENGINE : voiceEnv.read().SIDECAR_TTS_ENGINE;
    const isClone = engine === 'gpt-sovits' || engine === 'qwen3';
    if (isClone) {
      p.SIDECAR_TTS_TEXT_LANGUAGE = 'zh';
    } else if (typeof p.SIDECAR_TTS_SPEAK_LANG === 'string') {
      p.SIDECAR_TTS_TEXT_LANGUAGE = p.SIDECAR_TTS_SPEAK_LANG || 'zh';
    }
    const next = voiceEnv.write(p);
    // TTS 输出开关是运行时逻辑，无需重启侧车；其余配置变更需要重启让侧车立即生效。
    const needsRestart = Object.keys(p).some((k) => k !== 'SIDECAR_TTS_ENABLED');
    if ('SIDECAR_TTS_ENABLED' in p) state._ttsEnabledCache = p.SIDECAR_TTS_ENABLED !== 'false';
    if (needsRestart && voiceBridge.getStatus().running) voiceBridge.restart(); // 让新配置立即生效
    else if (!needsRestart) voice.broadcastVoiceStatus(); // 开关变化也要让 🔊 图标同步
    return next;
  }));
  ipcMain.handle(IPC.VoiceSettingsOpenPanel, () => { panels.openVoiceSettingsPanel(); return true; });
  ipcMain.handle(IPC.VoiceSettingsClosePanel, () => { panels.closeVoiceSettingsPanel(); return true; });
};
