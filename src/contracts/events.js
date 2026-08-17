// 事件类型常量单源（EventBus 与 pet-state 共用）。
// 所有 emit/on 的事件名都应引用这里的常量，避免各系统间字符串漂移。
// 新感知源/系统新增事件类型时，先在此登记，再在对应模块引用。
module.exports = Object.freeze({
  // —— 感知层（perception）——
  // 系统状态/时间轮询产生的节拍（P0-3 起由感知源发出）
  SENSING_TICK: 'sensing:tick',

  // —— 虚拟生活层（只改变 Core 本地状态，不触发真实外部行动）——
  LIFE: Object.freeze({
    ACTIVITY_COMPLETED: 'life:activity_completed',
  }),

  // —— pet 状态系统（pet-state）——
  // 状态触发事件（deltas 表 key，见 src/systems/pet-state.js 的 DELTAS）
  PET: Object.freeze({
    GREETING: 'pet:greeting',      // 问候
    CONVERSATION: 'pet:conversation', // 对话
    PRAISE: 'pet:praise',          // 夸奖
    LATE_NIGHT: 'pet:late_night',  // 深夜在线
    LONG_SESSION: 'pet:long_session', // 连续长时间在线
    NEGLECT: 'pet:neglect',        // 冷落
    FEED: 'pet:feed',              // 喂食/照顾
    // —— 养成阶段晋升广播（P0-2 发出；P1 记忆/P4 日记将来订阅）——
    STAGE_UP: 'pet:stage_up',
  }),
});
