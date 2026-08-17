// 主进程共享可变状态容器（唯一事实源）。
//
// 原先这些窗口引用 / 标志位 / 队列散落在 main.js 顶层作为模块级 let，
// 既无法单测也不易追踪。这里把它们集中为一个显式 state 对象：
//   - 让跨模块共享的变量「可见、可发现、可审计」
//   - 后续把 window / chat / voice / 生命周期拆成独立模块时，都从这里读写
//   - 便于在测试里直接构造/断言状态
//
// 用法：main.js 及各子模块 `const state = require('./shared-state');` 后读写 `state.xxx`。
module.exports = {
  // ---- 窗口引用 ----
  mainWindow: null,          // 桌宠主窗（Live2D + 气泡 + 语音播放宿主）
  chatInputWindow: null,     // 聊天输入窗
  balloonWindow: null,       // 独立气泡窗口（贴近角色头 / 可拖离）

  // ---- 聊天输入窗状态 ----
  chatInputExpanded: false,  // 是否已展开成普通窗口
  chatInputOpen: false,      // 是否处于打开状态
  interactionWindowCount: 0, // 菜单/设置等临时操作窗口数量；用于让桌宠不遮挡当前操作

  // ---- 聊天队列（enqueueChat 借此串行化；保存的是一个 Promise 引用）----
  chatQueue: Promise.resolve(),

  // ---- 气泡状态 ----
  balloonVisible: false,     // 气泡当前是否可见
  balloonFreed: false,       // 用户是否已把气泡拖离头顶；true=停在拖走后相对人物的位置（仍随人物移动）
  balloonFreedPos: null,     // 拖离后的绝对屏幕坐标（reanchor 时清空）
  balloonRelToMain: null,    // 气泡被拖走后与主窗的屏幕偏移；人物移动时据此保持相对位置一起跟随
  balloonHideTimer: null,    // 气泡隐藏延时定时器引用
  pendingBalloonRender: null, // 气泡窗口加载期间缓存的渲染指令，load 完成后 flush

  // ---- 跟随基准 ----
  lastMainWindowPos: null,   // 主窗上次位置：聊天输入窗据此实现“随人物一起拖动”

  // ---- 模型上下文 ----
  cachedModelMaxTokens: null, // 探测到的当前 active provider 模型上下文上限（null=未知）

  // ---- 语音（主进程侧）----
  isVoiceListening: { value: false }, // 聆听开关（用对象以便跨引用共享同一可变值）
  _speakBusy: false,         // 是否有一条朗读正在侧车合成中
  _speakPending: null,       // 合成进行时累积的最新待读文本（旧的被覆盖丢弃）
  _speakBusyTimer: null,     // 超时兜底：某条未回 audio（如 TTS 失败）时释放，防 busy 卡死
  _ttsEnabledCache: null,    // 语音输出开关的内存缓存（null=未初始化，首次读取 .env）
};
