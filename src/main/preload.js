const { contextBridge, ipcRenderer } = require('electron');

let deltaListener = null;
let historyListener = null;
let displayListener = null;

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
  }),
  setChatExpanded: (expanded) => ipcRenderer.invoke('chat:setExpanded', expanded),
  chatSubmit: (input) => ipcRenderer.invoke('chat:submit', input),
  onChatDelta: (callback) => {
    if (deltaListener) ipcRenderer.removeListener('chat:delta', deltaListener);
    deltaListener = (_event, data) => callback(data);
    ipcRenderer.on('chat:delta', deltaListener);
  },
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
  providers: Object.freeze({
    get: () => ipcRenderer.invoke('provider:getConfig'),
    save: (config) => ipcRenderer.invoke('provider:saveConfig', config),
    check: (provider) => ipcRenderer.invoke('provider:check', provider),
  }),
  openProviderPanel: () => ipcRenderer.invoke('provider:openPanel'),
  closeProviderPanel: () => ipcRenderer.invoke('provider:closePanel'),
  quit: () => ipcRenderer.invoke('menu:quit'),
}));
