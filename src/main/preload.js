const { contextBridge, ipcRenderer } = require('electron');

let deltaListener = null;
let historyListener = null;
let displayListener = null;
let asrPartialListener = null;
let asrFinalListener = null;
let listeningListener = null;
let audioListener = null;
let speakInterruptListener = null;
let statusListener = null;

contextBridge.exposeInMainWorld('desktopPet', Object.freeze({
  greet: () => ipcRenderer.invoke('character:greet'),
  personality: Object.freeze({
    get: () => ipcRenderer.invoke('personality:get'),
    set: (patch) => ipcRenderer.invoke('personality:set', patch),
    reset: () => ipcRenderer.invoke('personality:reset'),
  }),
  openChatInput: () => ipcRenderer.invoke('chat:openInput'),
  closeChatInput: () => ipcRenderer.invoke('chat:closeInput'),
  resizeChatInput: (height) => ipcRenderer.invoke('chat:resizeInput', height),
  getChatHistory: () => ipcRenderer.invoke('chat:getHistory'),
  memory: Object.freeze({
    getStatus: () => ipcRenderer.invoke('memory:getStatus'),
    getSettings: () => ipcRenderer.invoke('memory:getSettings'),
    setSettings: (patch) => ipcRenderer.invoke('memory:setSettings', patch),
    openPanel: () => ipcRenderer.invoke('memory:openPanel'),
    closePanel: () => ipcRenderer.invoke('memory:closePanel'),
  }),
  voice: Object.freeze({
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    getStatus: () => ipcRenderer.invoke('voice:getStatus'),
    sendPcm: (buffer) => ipcRenderer.send('voice:pcm', buffer),
    setListening: (on) => ipcRenderer.invoke('voice:setListening', Boolean(on)),
    setTtsEnabled: (on) => ipcRenderer.invoke('voice:setTtsEnabled', Boolean(on)),
    onAsrPartial: (callback) => {
      if (asrPartialListener) ipcRenderer.removeListener('voice:asr-partial', asrPartialListener);
      asrPartialListener = (_event, text) => callback(text);
      ipcRenderer.on('voice:asr-partial', asrPartialListener);
    },
    onAsrFinal: (callback) => {
      if (asrFinalListener) ipcRenderer.removeListener('voice:asr-final', asrFinalListener);
      asrFinalListener = (_event, text) => callback(text);
      ipcRenderer.on('voice:asr-final', asrFinalListener);
    },
    onListening: (callback) => {
      if (listeningListener) ipcRenderer.removeListener('voice:listening-changed', listeningListener);
      listeningListener = (_event, on) => callback(on);
      ipcRenderer.on('voice:listening-changed', listeningListener);
    },
    onAudio: (callback) => {
      if (audioListener) ipcRenderer.removeListener('voice:audio', audioListener);
      audioListener = (_event, audio) => callback(audio);
      ipcRenderer.on('voice:audio', audioListener);
    },
    onSpeakInterrupt: (callback) => {
      if (speakInterruptListener) ipcRenderer.removeListener('voice:speak-interrupt', speakInterruptListener);
      speakInterruptListener = () => callback();
      ipcRenderer.on('voice:speak-interrupt', speakInterruptListener);
    },
    onStatus: (callback) => {
      if (statusListener) ipcRenderer.removeListener('voice:status', statusListener);
      statusListener = (_event, s) => callback(s);
      ipcRenderer.on('voice:status', statusListener);
    },
  }),
  setChatExpanded: (expanded) => ipcRenderer.invoke('chat:setExpanded', expanded),
  chatSubmit: (input) => ipcRenderer.invoke('chat:submit', input),
  onChatDelta: (callback) => {
    if (deltaListener) ipcRenderer.removeListener('chat:delta', deltaListener);
    deltaListener = (_event, data) => callback(data);
    ipcRenderer.on('chat:delta', deltaListener);
  },
  // 气泡（独立窗口）：宠物窗发指令 → 主进程转发到气泡窗口渲染
  balloon: Object.freeze({
    show: (payload) => ipcRenderer.invoke('balloon:show', payload),
    update: (full) => ipcRenderer.invoke('balloon:update', full),
    finish: (payload) => ipcRenderer.invoke('balloon:finish', payload),
    hide: () => ipcRenderer.invoke('balloon:hide'),
  }),
  // 气泡窗口自身：接收渲染命令 + 拖拽控制
  balloonWindow: Object.freeze({
    onRender: (callback) => ipcRenderer.on('balloon:render', (_event, data) => callback(data)),
    ready: () => ipcRenderer.invoke('balloon:ready'),
    dragMove: (x, y) => ipcRenderer.invoke('balloonWindow:dragMove', x, y),
    release: () => ipcRenderer.invoke('balloonWindow:release'),
    reanchor: () => ipcRenderer.invoke('balloonWindow:reanchor'),
  }),
  onChatHistory: (callback) => {
    if (historyListener) ipcRenderer.removeListener('chat:history', historyListener);
    historyListener = (_event, data) => callback(data);
    ipcRenderer.on('chat:history', historyListener);
  },
  moveBy: (dx, dy) => ipcRenderer.send('window:moveBy', dx, dy),
  moveTo: (x, y) => ipcRenderer.send('window:moveTo', x, y),
  setDragState: (dragging) => ipcRenderer.send('window:setDragState', dragging),
  setMousePassthrough: (passthrough) => ipcRenderer.send('window:setMousePassthrough', passthrough),
  openMenu: (x, y) => ipcRenderer.invoke('menu:open', x, y),
  menuReady: () => ipcRenderer.invoke('menu:ready'),
  closeMenu: () => ipcRenderer.invoke('menu:close'),
  openPersonalityPanel: () => ipcRenderer.invoke('personality:openPanel'),
  closePersonalityPanel: () => ipcRenderer.invoke('personality:closePanel'),
  display: Object.freeze({
    get: () => ipcRenderer.invoke('display:get'),
    set: (patch) => ipcRenderer.invoke('display:set', patch),
    preview: (patch) => ipcRenderer.invoke('display:preview', patch),
    onChanged: (callback) => {
      if (displayListener) ipcRenderer.removeListener('display:changed', displayListener);
      displayListener = (_event, data) => callback(data);
      ipcRenderer.on('display:changed', displayListener);
    },
  }),
  openDisplayPanel: () => ipcRenderer.invoke('display:openPanel'),
  closeDisplayPanel: () => ipcRenderer.invoke('display:closePanel'),
  voiceSettings: Object.freeze({
    get: () => ipcRenderer.invoke('voiceSettings:get'),
    set: (patch) => ipcRenderer.invoke('voiceSettings:set', patch),
  }),
  openVoiceSettingsPanel: () => ipcRenderer.invoke('voiceSettings:openPanel'),
  closeVoiceSettingsPanel: () => ipcRenderer.invoke('voiceSettings:closePanel'),
  providers: Object.freeze({
    get: () => ipcRenderer.invoke('provider:getConfig'),
    save: (config) => ipcRenderer.invoke('provider:saveConfig', config),
    check: (provider) => ipcRenderer.invoke('provider:check', provider),
  }),
  openProviderPanel: () => ipcRenderer.invoke('provider:openPanel'),
  closeProviderPanel: () => ipcRenderer.invoke('provider:closePanel'),
  context: Object.freeze({
    get: () => ipcRenderer.invoke('context:get'),
    set: (patch) => ipcRenderer.invoke('context:set', patch),
    probe: () => ipcRenderer.invoke('context:probe'),
  }),
  openContextPanel: () => ipcRenderer.invoke('context:openPanel'),
  closeContextPanel: () => ipcRenderer.invoke('context:closePanel'),
  quit: () => ipcRenderer.invoke('menu:quit'),
}));
