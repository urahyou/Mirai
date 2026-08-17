// ─────────────────────────────────────────────────────────────────────────────
// IPC 通道契约 · 单一事实源（main 侧）
// ─────────────────────────────────────────────────────────────────────────────
// main 侧所有 ipcMain.handle/on 的通道名都应引用这里的常量，避免各模块间漂移。
// preload 运行在渲染沙箱、无法 require 本地文件，故仍以字符串暴露；两端一致性
// 由 test/ipc-contract.test.js 的“main ↔ preload 通道全比对”自动守住。
// renderer 只通过 window.desktopPet.* 访问，不直接接触通道名。
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // 角色点击回应 / 聊天（chat.js）
  CharacterGreet: 'character:greet',
  ChatDelta: 'chat:delta',
  ChatHistory: 'chat:history',
  ChatSubmit: 'chat:submit',
  ChatOpenInput: 'chat:openInput',
  ChatCloseInput: 'chat:closeInput',
  ChatGetHistory: 'chat:getHistory',
  ChatSetExpanded: 'chat:setExpanded',
  ChatResizeInput: 'chat:resizeInput',

  // 气泡（balloon.js + main.js 转发）
  BalloonShow: 'balloon:show',
  BalloonUpdate: 'balloon:update',
  BalloonFinish: 'balloon:finish',
  BalloonHide: 'balloon:hide',
  BalloonRender: 'balloon:render',
  BalloonReady: 'balloon:ready',
  BalloonDragMove: 'balloonWindow:dragMove',
  BalloonRelease: 'balloonWindow:release',
  BalloonReanchor: 'balloonWindow:reanchor',

  // 语音（voice.js）
  VoiceStart: 'voice:start',
  VoiceStop: 'voice:stop',
  VoiceGetStatus: 'voice:getStatus',
  VoiceSetListening: 'voice:setListening',
  VoiceSetTtsEnabled: 'voice:setTtsEnabled',
  VoicePcm: 'voice:pcm',
  VoiceStatus: 'voice:status',
  VoiceListeningChanged: 'voice:listening-changed',
  VoiceAsrPartial: 'voice:asr-partial',
  VoiceAsrFinal: 'voice:asr-final',
  VoiceAudio: 'voice:audio',
  VoicePlaybackFinished: 'voice:playback-finished',
  VoiceSpeakInterrupt: 'voice:speak-interrupt',

  // 菜单（panel.js）
  MenuOpen: 'menu:open',
  MenuReady: 'menu:ready',
  MenuClose: 'menu:close',
  MenuQuit: 'menu:quit',

  // 人格（main.js）
  PersonalityGet: 'personality:get',
  PersonalitySet: 'personality:set',
  PersonalityReset: 'personality:reset',
  PersonalityOpenPanel: 'personality:openPanel',
  PersonalityClosePanel: 'personality:closePanel',

  // 显示（main.js）
  DisplayGet: 'display:get',
  DisplaySet: 'display:set',
  DisplayPreview: 'display:preview',
  DisplayChanged: 'display:changed',
  DisplayOpenPanel: 'display:openPanel',
  DisplayClosePanel: 'display:closePanel',
  PetStateGet: 'petState:get',

  // 日记 & 系统感知（P1，面板可见入口）
  DiaryGetToday: 'diary:getToday',
  DiaryGenerateToday: 'diary:generateToday',
  DiaryOpenFolder: 'diary:openFolder',
  SystemSenseGet: 'systemSense:get',
  InitiativeGet: 'initiative:get',
  InitiativeSet: 'initiative:set',

  // 设置中心体系（2026-08）
  SettingsCenterOpen: 'settings:openCenter',
  SettingsCenterClose: 'settings:closeCenter',
  AppearanceOpen: 'appearance:open',
  AppearanceClose: 'appearance:close',
  BehaviorOpen: 'behavior:open',
  BehaviorClose: 'behavior:close',
  CompanionOpen: 'companion:open',
  CompanionClose: 'companion:close',
  // 语音设置 .env（main.js）
  VoiceSettingsGet: 'voiceSettings:get',
  VoiceSettingsSet: 'voiceSettings:set',
  VoiceSettingsOpenPanel: 'voiceSettings:openPanel',
  VoiceSettingsClosePanel: 'voiceSettings:closePanel',

  // Provider（main.js）
  ProviderGetConfig: 'provider:getConfig',
  ProviderSaveConfig: 'provider:saveConfig',
  ProviderCheck: 'provider:check',
  ProviderOpenPanel: 'provider:openPanel',
  ProviderClosePanel: 'provider:closePanel',

  // 上下文设置（main.js）
  ContextGet: 'context:get',
  ContextSet: 'context:set',
  ContextProbe: 'context:probe',
  ContextOpenPanel: 'context:openPanel',
  ContextClosePanel: 'context:closePanel',

  // 本地长期记忆（Python Core SQLite）
  MemoryGetStatus: 'memory:getStatus',
  MemoryOpenPanel: 'memory:openPanel',
  MemoryClosePanel: 'memory:closePanel',

  // 窗口控制（main.js，宠物窗/气泡窗拖拽）
  WindowMoveBy: 'window:moveBy',
  WindowMoveTo: 'window:moveTo',
  WindowSetDragState: 'window:setDragState',
  WindowSetMousePassthrough: 'window:setMousePassthrough',
};
