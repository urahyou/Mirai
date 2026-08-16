// 语音子系统（主进程侧）：朗读合成去重、语音识别分发、语音状态广播与语音 IPC。
//
// 通过依赖注入（createVoice）获得所需能力，避免触碰主进程其它模块的可变全局：
//   - voiceBridge / generic / voiceEnv / ipcMain / state
//   - sendToChatInput / handleUserUtterance（由主进程提供，避免互相 require 造成循环）
// 共享可变状态（state.isVoiceListening / state._speakBusy 等）统一读写 state。
const IPC = require('../contracts/ipc');
module.exports = function createVoice({
  voiceBridge, generic, voiceEnv, ipcMain, state,
  sendToChatInput, handleUserUtterance,
}) {
  // 让小未来开口（把文字交给侧车合成并播放）
  // 若 .env 设了 SIDECAR_TTS_SPEAK_LANG（如 ja=日语），则先把“中文回复”翻成该语言再发音；
  // 屏幕上显示的气泡文字（chatHistory/chat-input）保持中文不变 —— 实现“中文文字 + 外语朗读”。
  // SIDECAR_TTS_ENABLED=false 时关闭语音输出（沉默模式，只显示文字不发声）。
  // main 端合成去重：同一时刻最多让侧车合成一条，连续 speak 只保留最新一句，
  // 避免侧车堆积合成一堆会被渲染端丢弃的句子（浪费算力，尤其 GPT-SoVITS）。
  function speak(text) {
    const t = String(text || '').trim();
    if (!t) return;
    if (!voiceOutputEnabled()) return;
    if (state._speakBusy) {
      // 上一条还在合成：不发送，只保留最新一句（旧的丢弃）
      state._speakPending = t;
      return;
    }
    state._speakBusy = true;
    state._speakPending = null;
    clearTimeout(state._speakBusyTimer);
    state._speakBusyTimer = setTimeout(() => {
      state._speakBusy = false;
      const pending = state._speakPending;
      state._speakPending = null;
      if (pending) speak(pending);
    }, 20000);
    const speakLang = String(voiceBridge.getSidecarEnv().SIDECAR_TTS_SPEAK_LANG || '').trim();
    if (speakLang) {
      // 先翻译再发音，失败则回退原话，避免没声
      generic.translate(t, speakLang)
        .then((jp) => voiceBridge.speak((jp && jp.trim()) ? jp : t))
        .catch(() => voiceBridge.speak(t));
      return;
    }
    voiceBridge.speak(t);
  }

  // 语音输出开关：读取 .env 的 SIDECAR_TTS_ENABLED，防止误写时静音判定出错用白名单。
  // 用内存缓存避免 speak() 每句都读盘；写入时由 setVoiceTtsEnabled / voiceSettings:set 同步刷新。
  function voiceOutputEnabled() {
    if (state._ttsEnabledCache === null) {
      const v = String(voiceEnv.read().SIDECAR_TTS_ENABLED || 'true').trim().toLowerCase();
      state._ttsEnabledCache = !(v === 'false' || v === '0' || v === 'off' || v === 'no');
    }
    return state._ttsEnabledCache;
  }

  // 向两个窗口广播语音状态（聆听开关 + 侧车就绪度 + 语音输出开关），供 🎤/🔊 图标显示状态
  function broadcastVoiceStatus() {
    const status = { ...voiceBridge.getStatus(), listening: state.isVoiceListening.value, ttsEnabled: voiceOutputEnabled() };
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.webContents.send(IPC.VoiceStatus, status);
    sendToChatInput(IPC.VoiceStatus, status);
  }

  // 向两个窗口广播聆听开关状态（宠物窗 + 对话窗）
  function broadcastVoiceListening() {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.webContents.send(IPC.VoiceListeningChanged, state.isVoiceListening.value);
    sendToChatInput(IPC.VoiceListeningChanged, state.isVoiceListening.value);
  }

  function setVoiceListening(on) {
    state.isVoiceListening.value = Boolean(on);
    if (state.isVoiceListening.value) voiceBridge.start();
    broadcastVoiceListening();
    broadcastVoiceStatus();
  }

  // 语音输出开关：写入 .env 的 SIDECAR_TTS_ENABLED，并广播让宠物窗/对话窗 🔊 图标同步
  function setVoiceTtsEnabled(on) {
    const enabled = Boolean(on);
    try {
      voiceEnv.write({ SIDECAR_TTS_ENABLED: enabled ? 'true' : 'false' });
    } catch (e) {
      console.error('[voice] 写入 SIDECAR_TTS_ENABLED 失败:', e.message);
    }
    state._ttsEnabledCache = enabled;
    broadcastVoiceStatus();
  }

  // 侧车就绪/退出 → 刷新两侧 🎤 状态（加载中⇄就绪）
  voiceBridge.on('ready-change', broadcastVoiceStatus);

  // 飘字：实时部分识别 → 填进对话窗输入框（说话文字显示在“输入对话框”）
  voiceBridge.on('asr-partial', (text) => {
    if (!state.isVoiceListening.value) return;
    sendToChatInput(IPC.VoiceAsrPartial, text);
  });

  // 最终识别：对话窗开着→填输入框（是否自动发送由对话窗决定）；对话窗关着→直接自动发送（回复走气泡）
  voiceBridge.on('asr', (text) => {
    if (!state.isVoiceListening.value) return;
    const t = String(text || '').trim();
    if (!t) return;
    if (state.chatInputOpen) sendToChatInput(IPC.VoiceAsrFinal, t);
    else void handleUserUtterance(t);
  });

  // 让主窗口（宠物窗）播放小未来的语音
  voiceBridge.on('audio', (audio) => {
    // 本条已合成完成 → 释放 busy；若期间又积累了最新待读文本，立即发起它（打断式：旧退场新上场）
    if (state._speakBusy) {
      clearTimeout(state._speakBusyTimer);
      state._speakBusy = false;
      const pending = state._speakPending;
      state._speakPending = null;
      if (pending) speak(pending);
    }
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(IPC.VoiceAudio, {
        id: audio.id,
        format: audio.format || 'mp3',
        data: audio.data, // Buffer → 序列化为 Uint8Array，renderer 端解码播放
      });
    }
  });

  // 你开口说话时（speech_start）→ 通知宠物窗打断正在播放的语音，转听你说
  // 注意：回调参数用 vadState 而非 state，避免遮蔽模块级 state 对象。
  voiceBridge.on('vad', (vadState) => {
    if (vadState === 'speech_start' && state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(IPC.VoiceSpeakInterrupt);
    }
  });

  ipcMain.handle(IPC.VoiceStart, () => {
    voiceBridge.start();
    return voiceBridge.getStatus();
  });
  ipcMain.handle(IPC.VoiceStop, () => {
    voiceBridge.stop();
    return true;
  });
  ipcMain.handle(IPC.VoiceGetStatus, () => ({ ...voiceBridge.getStatus(), listening: state.isVoiceListening.value, ttsEnabled: voiceOutputEnabled() }));
  ipcMain.handle(IPC.VoiceSetListening, (_event, on) => {
    setVoiceListening(on);
    return state.isVoiceListening.value;
  });
  ipcMain.handle(IPC.VoiceSetTtsEnabled, (_event, on) => {
    setVoiceTtsEnabled(on);
    return voiceOutputEnabled();
  });
  ipcMain.on(IPC.VoicePcm, (_event, buffer) => voiceBridge.sendPcm(buffer));

  return {
    speak,
    broadcastVoiceStatus,
    setVoiceListening,
    setVoiceTtsEnabled,
  };
};
