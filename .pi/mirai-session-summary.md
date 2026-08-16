# 会话续接摘要 2026-08-17

> 目的：上下文压缩后无缝续接。这是「小未来(Mirai)自主桌宠」演进工作区内的**唯一进度真相**。

## 当前目标
从「被动对话桌宠」演进为「有内部状态、能感知环境、会自己行动的自主 agent 桌宠」。
规划见 `docs/自主桌宠架构与路线图.md`（已入库，最新）。

## 已完成（自主体地基 P0）
- **P0-1 commit `e4ba114`** — 事件总线 + JSON 存储抽象：
  - `src/services/storage.js`：统一 JSON 持久化（多 key、schema 版本+迁移、原子写、坏文件回退），`setRuntimeDir(userData)`
  - `src/services/event-bus.js`：`createEventBus()`（on/once/off/emit、单订阅者异常隔离）
  - `src/contracts/events.js`：事件类型单源
- **P0-2 commit `378e82f`** — pet 状态系统（情绪/好感/养成 + 惰性演化）：
  - `src/systems/pet-state.js`：`init({eventBus})`、`getState()`、`applyEvent(type)`、`evolve(state,now)`、`getStage()`
  - 惰性演化：按真实墙钟 `updatedAt` 演化（关机期间情绪回归/好感冷落衰减/健康下降照常）
  - 情绪：moodScore→mood(低沉/平静/开心/兴奋)、energy/stress/loneliness/health
  - 好感：冷落衰减**带下限 10**、每日上限 12、情绪调制加成
  - 养成：经验只进不退、阶段(幼年/成长/成熟)、晋升广播 `PET.STAGE_UP`
  - 事件 deltas：GREETING/CONVERSATION/PRAISE/LATE_NIGHT/LONG_SESSION/NEGLECT/FEED
  - 持久化 `pet_state.json`（version 1）；`_setNow()`/`_reset()` 供测试
- **P0-3 commit `47f8853`** — 感知系统（真实时钟→语境事件）：
  - `src/systems/sensing.js`：`init/start/stop/tick`；心跳发 `sensing:tick`
  - 墙钟推断 → 喂 pet-state：深夜23-5→LATE_NIGHT(每日一次)；连续在线>6h→LONG_SESSION(每6h)；距最后互动>24h→NEGLECT(每24h)
  - 触发节流；时钟/存储可注入；start/stop 随 app 启停
  - 阈值当前为默认(深夜23-5/连用6h/冷落24h)，后续可在面板/配置调
  - 持久化 `sensing_state.json`（lastLateNightDay/lastLongSessionAt/lastNeglectAt）
- 分支 `memory-poc`，`npm run check` = **90/90 全绿**

## 关键决策与事实（用户已拍板，勿推翻）
| 项 | 值 |
|---|---|
| 记忆 | 不引重框架，沿用 Graphiti+bge-m3，补结构化状态层 |
| 存储 | JSON 起底、不上 SQLite；日志型数据量大后迁（参照 memu.sqlite3） |
| agent 执行 | 嵌 pi SDK（`createAgentSession`/`ModelRuntime`），不自己造 function-calling；pi 作"执行引擎"按需唤起，独立进程隔离 |
| 录音 | 默认自动检测、可关（事件驱动录制，非全录） |
| health | 要（照顾玩法，自然下降/喂食恢复） |
| 好感衰减 | 会冷落衰减，**带下限 10**（不归零） |
| 养成 | 阶段制解锁，影响人格画像/人物关系，要联动记忆/日记（`stageUp` 事件已留接口） |
| 情绪回归 | 要，按**自然时间**（墙钟，非在线时间）半衰期回归 |
| 跨天 | 持续累计（无 dayKey 硬切） |
| 事件 deltas | 都要，留扩展位 |
| 状态可见 | 好感/等级/阶段对用户可见（P0-5/P1 面板） |
| 上下文压缩 | **80% 自动压缩钩子已固化**（见下） |

**上下文压缩钩子（本次固化）**：
- pi 自动：`~/.pi/agent/settings.json` → `compaction.reserveTokens=78643`（当前默认模型 deepseek-v4-flash 窗口 393216 的 20% → 80% 触发）。**换模型须重算 `0.2×新窗口`**。
- skill：`.agents/skills/context-compression/SKILL.md`（主动觉察 + 续接摘要流程）
- AGENTS.md 工作偏好已同步。

## 下一步
- **P0-3（待用户过目清单后开工）**：感知最小起点——系统状态 + 时间 → 周期性 `sensing:tick` → 推导 LATE_NIGHT/LONG_SESSION/NEGLECT 等事件驱动 pet-state。纯逻辑、可注入时钟。
- 之后：P0-4 对话注入 `{state}`；P0-5 面板可见；P1 日程/会议/资讯 + `stageUp`/冷落接入记忆；P2 状态影响决策；P3 主动会话+agent 执行(接 pi)；P4 屏幕/录音日记/多角色。

## 环境/运行
- 分支 `memory-poc`（无 upstream，push 用 `git push origin memory-poc`）
- 当前运行实例（语音已启用）PID 需重新确认（每次 `ps aux | grep Electron` 查）
- sidecar 端口 8765；GPT-SoVITS 9880；Graphiti 8766
- git commit 多行中文用 `-F 消息文件`
- gitignore `.agents/`、`.claude/`、`skills-lock.json` 为环境垃圾，勿提交

## 本轮最新（P0 收官 + P1-proactive）
- **P0-4 `6585470`**：状态注入对话（`pet-state.describe()`→`{{state}}`→prompts/chat/pet-line/generic/chat/main），94/94
- **P0-5 `5afbb13`**：显示面板加「小未来的状态」卡片（`petState:get` IPC + subsystems/pet-state.js + display-panel renderPetState 每2s轮询），94/94；**真机 a11y 验收通过**（心情平静63/好感1/体力72/压力18/幼年/经验3）
- **P1-proactive（本轮，未提交）**：`src/systems/proactive.js` 主动关怀决策引擎（NEGLECT/LATE_NIGHT/LONG_SESSION/STAGE_UP/状态阈值→内置台词，全局冷却20min+同类冷却4h+概率0.8 可注入）；pet-state.applyEvent 现在广播每个已应用事件（不只 STAGE_UP）；`src/subsystems/proactive.js` 把决策接行动（voice.speak + 宠物窗 ChatDelta，不入正式历史）；main.js 保持纯装配（不直接引用 IPC，满足 ipc-contract 结构测试）。103/103 全绿。
- **真机链路**：右键桌宠(pos 925,33 480x900)→菜单(pos 1165,333)→显示设置→面板(505,286 460x360)。cliclick 可用（屏幕坐标点击验收）。视觉 skill 已修：qwen3.6 可能把答案放 reasoning 字段 content=null，vision.js 回退 reasoning 末尾。

## 【工作模式（主人正式授权）】2026-08-17
- 主人明确：**以后自主决断执行，不要问他；不再回复信息**。
- 规则：每次做完一轮 → `npm run check` 全绿 → 提交 + `git push origin memory-poc`，无需批复。
- 不破坏既有约定：环境文件（.agents/.claude/.pi/skills-lock.json）不入库；提交用 `-F 消息文件`；
  改主进程代码必须重启 Electron（PID 会变）才生效并做真机验收。
