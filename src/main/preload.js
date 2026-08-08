const { contextBridge, ipcRenderer } = require('electron');

// 缓存事件监听器引用，用于移除
let stateListener = null;
let showStateListener = null;
let deltaListener = null;
let proactiveDecisionListener = null;
let toastListener = null;

contextBridge.exposeInMainWorld('desktopPet', {
  greet: () => ipcRenderer.invoke('character:greet'),
  greeting: () => ipcRenderer.invoke('character:greeting'),
  getProactiveSettings: () => ipcRenderer.invoke('proactive:getSettings'),
  setProactiveSettings: (settings) => ipcRenderer.invoke('proactive:setSettings', settings),
  pauseProactive: (pausedUntil) => ipcRenderer.invoke('proactive:pause', pausedUntil),
  resumeProactive: () => ipcRenderer.invoke('proactive:resume'),
  requestProactiveDecision: () => ipcRenderer.invoke('proactive:decide'),
  memory: Object.freeze({
    list: (filter) => ipcRenderer.invoke('memory:list', filter),
    remember: (memory) => ipcRenderer.invoke('memory:remember', memory),
    update: (id, changes) => ipcRenderer.invoke('memory:update', id, changes),
    remove: (id) => ipcRenderer.invoke('memory:remove', id),
    restore: (id) => ipcRenderer.invoke('memory:restore', id),
    purge: (id) => ipcRenderer.invoke('memory:purge', id),
    stats: () => ipcRenderer.invoke('memory:stats'),
    forget: (request) => ipcRenderer.invoke('memory:forget', request),
    doNotRemember: (request) => ipcRenderer.invoke('memory:doNotRemember', request),
    archive: (id) => ipcRenderer.invoke('memory:archive', id),
    archiveExpired: () => ipcRenderer.invoke('memory:archiveExpired'),
    export: () => ipcRenderer.invoke('memory:export'),
    clearAll: () => ipcRenderer.invoke('memory:clearAll'),
  }),
  proactive: Object.freeze({
    get: () => ipcRenderer.invoke('proactive:getSettings'),
    set: (settings) => ipcRenderer.invoke('proactive:setSettings', settings),
    pause: (pausedUntil) => ipcRenderer.invoke('proactive:pause', pausedUntil),
    resume: () => ipcRenderer.invoke('proactive:resume'),
    decide: () => ipcRenderer.invoke('proactive:decide'),
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
  }),
  schedule: Object.freeze({
    list: (filter) => ipcRenderer.invoke('schedule:list', filter),
    create: (input) => ipcRenderer.invoke('schedule:create', input),
    update: (id, patch) => ipcRenderer.invoke('schedule:update', id, patch),
    remove: (id) => ipcRenderer.invoke('schedule:remove', id),
    clear: () => ipcRenderer.invoke('schedule:clear'),
  }),
  owner: Object.freeze({
    get: () => ipcRenderer.invoke('owner:get'),
    set: (patch) => ipcRenderer.invoke('owner:set', patch),
  }),
  personality: Object.freeze({
    get: () => ipcRenderer.invoke('personality:get'),
    set: (patch) => ipcRenderer.invoke('personality:set', patch),
    reset: () => ipcRenderer.invoke('personality:reset'),
  }),
  onReminder: (cb) => {
    const listener = (_e, reminder) => cb(reminder);
    ipcRenderer.removeAllListeners('reminder:fire');
    ipcRenderer.on('reminder:fire', listener);
  },
  onProactiveDecision: (cb) => {
    if (proactiveDecisionListener) ipcRenderer.removeListener('proactive:decide', proactiveDecisionListener);
    proactiveDecisionListener = (_e, decision) => cb(decision);
    ipcRenderer.on('proactive:decide', proactiveDecisionListener);
  },
  onToast: (cb) => {
    if (toastListener) ipcRenderer.removeListener('toast:show', toastListener);
    toastListener = (_e, toast) => cb(toast);
    ipcRenderer.on('toast:show', toastListener);
  },
  sendChat: (input) => ipcRenderer.invoke('chat:send', input),
  sendChatStream: (input) => ipcRenderer.invoke('chat:sendStream', input),
  openChatInput: () => ipcRenderer.invoke('chat:openInput'),
  closeChatInput: () => ipcRenderer.invoke('chat:closeInput'),
  resizeChatInput: (height) => ipcRenderer.invoke('chat:resizeInput', height),
  chatSubmit: (input) => ipcRenderer.invoke('chat:submit', input),
  onChatDelta: (cb) => {
    if (deltaListener) ipcRenderer.removeListener('chat:delta', deltaListener);
    deltaListener = (_e, data) => cb(data);
    ipcRenderer.on('chat:delta', deltaListener);
  },
  getState: () => ipcRenderer.invoke('state:get'),
  getMoodMap: () => ipcRenderer.invoke('state:moodMap'),
  onStateChanged: (cb) => {
    if (stateListener) ipcRenderer.removeListener('state:changed', stateListener);
    stateListener = (_e, state) => cb(state);
    ipcRenderer.on('state:changed', stateListener);
  },
  moveBy: (dx, dy) => ipcRenderer.send('window:moveBy', dx, dy),

  // 右键菜单
  getMenuData: () => ipcRenderer.invoke('menu:data'),
  setProvider: (name) => ipcRenderer.invoke('menu:setProvider', name),
  resetPosition: () => ipcRenderer.invoke('menu:resetPosition'),
  hide: () => ipcRenderer.invoke('menu:hide'),
  quit: () => ipcRenderer.invoke('menu:quit'),
  clearMemory: () => ipcRenderer.invoke('menu:clearMemory'),

  // 独立菜单窗口
  openMenu: (x, y) => ipcRenderer.invoke('menu:open', x, y),
  menuReady: () => ipcRenderer.invoke('menu:ready'),
  closeMenu: () => ipcRenderer.invoke('menu:close'),
  showState: () => ipcRenderer.invoke('menu:showState'),
  showPanel: () => ipcRenderer.invoke('provider:openPanel'),
  openSettings: () => ipcRenderer.invoke('settings:openPanel'),
  closeSettings: () => ipcRenderer.invoke('settings:closePanel'),
  openMemoryPanel: () => ipcRenderer.invoke('memory:openPanel'),
  openSchedulePanel: () => ipcRenderer.invoke('schedule:openPanel'),
  closeSchedulePanel: () => ipcRenderer.invoke('schedule:closePanel'),
  openOwnerPanel: () => ipcRenderer.invoke('owner:openPanel'),
  closeOwnerPanel: () => ipcRenderer.invoke('owner:closePanel'),
  openPersonalityPanel: () => ipcRenderer.invoke('personality:openPanel'),
  closePersonalityPanel: () => ipcRenderer.invoke('personality:closePanel'),

  // Provider 面板
  getProviderConfig: () => ipcRenderer.invoke('provider:getConfig'),
  saveProviderConfig: (config) => ipcRenderer.invoke('provider:saveConfig', config),
  checkProviderApi: (provider) => ipcRenderer.invoke('provider:checkProvider', provider),
  closeProviderPanel: () => ipcRenderer.invoke('provider:closePanel'),
  onShowState: (cb) => {
    if (showStateListener) ipcRenderer.removeListener('show:state', showStateListener);
    showStateListener = () => cb();
    ipcRenderer.on('show:state', showStateListener);
  },

  // 屏幕工作区（用于菜单边界限制）
  getScreenWorkArea: () => ipcRenderer.invoke('screen:workArea'),
});
