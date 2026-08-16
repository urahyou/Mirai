// 事件类型常量单源（EventBus 用）。
// 所有 emit/on 的事件名都应引用这里的常量，避免各系统间字符串漂移。
// 新感知源/系统新增事件类型时，先在此登记，再在对应模块引用。
module.exports = Object.freeze({
  // —— 感知层（perception）——
  // 系统状态/时间轮询产生的节拍（P0-2 起由感知源发出）
  SENSING_TICK: 'sensing:tick',
  // 屏幕/音频/资讯等后续感知源事件在此追加
});
