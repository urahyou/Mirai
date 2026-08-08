# 小未来桌面管家执行规格（SPEC）

- 文档版本：0.2
- 状态：Draft
- 适用项目：伪春菜复兴计划
- 当前基线：Electron 43.3.0、原生 HTML/CSS/JavaScript、OpenAI 兼容 LLM（纯 JSON 存储）
- 目标：把当前聊天桌宠演进为具备情感、记忆、日程和安全 Agent 能力的本地桌面管家

> 本文档是**未来蓝图**。当前实际已实现功能、文件结构与验收方式见《功能文档.md》与《设计文档.md》，两者为准。
> 自 0.2 起，「当前实施进度」按 Spec 各 Phase 对照实际代码更新，避免与功能文档冲突。

当前实施进度（对照实际代码，2026-08）：

- Phase 0（重构与可测试性）：部分完成。已有 storage 抽象（`services/json-storage.js`）、对话编排薄封装（`conversation-orchestrator.js`）、统一 IPC 校验（`ipc-validation.js`）与 `npm run check` 测试（48 用例）。**仍缺**：IPC 拆分到 `main/ipc*.js`、SQLite/数据库层与 migration 框架。
- Phase 1（情感/好感/健康）：已完成。情感 reducer、时间衰减、事件日志、LLM 状态注入、状态面板、表情联动均已落地；情感历史接口与更多行为映射可继续扩展。
- Phase 2（多轮对话与长期记忆）：已完成。进程内 12 轮历史 + 跨重启长期记忆（增删查/归档/注入/记忆面板/`不要记住`）均已实现；仍是关键词/类型/重要性检索，无向量检索。
- Phase 3（只读 Agent 与体检）：未开始（无工具注册表 / Agent Worker / 任务面板）。
- Phase 4（日程、提醒与克制的主动性）：基础已完成。日程增删改、重复规则、安静时段、到期提醒、主动搭话频率限制与 LLM 生成均已实现；缺"久坐/深夜/盘满"类健康提醒与补发策略。
- Phase 5（受控写操作与代码 Agent）：未开始。
- Phase 6（安全扫描与隔离区）：未开始。
- Phase 7（角色表现、成长与发布）：部分。多表情（idle/happy/sad）与 LLM 主动开场已有；缺 excited/tired/love/working 表情、任务动画、每日总结/纪念日、皮肤体系与 .dmg/.exe 打包。


## 1. 产品目标

小未来应同时具备四种身份：

1. 有稳定人格和状态变化的桌面角色。
2. 能记住用户偏好、事件和当前工作的长期伙伴。
3. 能安排提醒、观察电脑状态并主动汇报的管家。
4. 能在权限控制下读取文件、运行代码和执行多步任务的 Agent。

产品的核心体验不是单纯“回答问题”，而是：

```text
理解用户
  → 记住相关信息
  → 形成持续状态
  → 在合适时机主动响应
  → 经过授权后执行任务
  → 记录结果并形成新的记忆
```

## 2. 核心原则

### 2.1 本地优先

- 用户记忆、情感状态、任务日志和日程默认保存在本机。
- LLM Provider 继续支持局域网 vLLM、Ollama 和 LM Studio。
- 未经用户授权，不向第三方服务上传文件、记忆或系统信息。

### 2.2 情感与权限分离

- 好感度只影响称呼、语气、主动性、动画和角色内容。
- 好感度不得提高系统权限。
- 删除文件、执行命令、安装软件等权限只由用户设置和审批决定。

### 2.3 可解释和可撤销

- Agent 执行前应展示任务计划、目标、风险和预计影响。
- 写操作必须记录执行日志。
- 可恢复的操作优先使用移动、备份或隔离，而不是永久删除。
- 用户可以取消正在执行的任务。

### 2.4 情感表达不得操控用户

- 长时间不互动可以让角色表现为安静、无聊或想念。
- 不得用生病、掉好感、拒绝工作等方式强迫用户互动。
- 用户可关闭主动提醒、好感系统或情绪化表达。

## 3. 当前项目基线

当前已经具备：

- 透明、无边框、置顶的 Electron 桌宠窗口。
- 角色拖动、单击打招呼、双击聊天。
- idle、happy、sad 三种表情。
- 对话/开场白/点击/主动搭话全部走大模型（无本地关键词规则与预设台词）。
- OpenAI 兼容 LLM 调用（流式输出），多 Provider 自动回退。
- DeepSeek/vLLM、Ollama、LM Studio Provider 配置与设置面板（持久化）。
- 长期记忆（增删查/归档/注入/记忆面板）。
- 日程与到期提醒（重复规则/安静时段/日程面板）。
- 情感状态持久化、状态面板、情感注入与时间衰减。
- 自定义右键菜单与多设置面板（Provider/设置/日程/关于主人/性格）。
- 可编辑人格（运行时覆盖 + 恢复出厂）。
- 20～60 秒主动搭话（LLM 生成 + 频率预算）。
- 自动化测试（node:test，48 用例）与统一 IPC 校验。

当前缺少：

- Agent 工具系统（只读体检 / 受控写操作 / 代码 Agent）与审批流。
- 系统体检与安全扫描、隔离区。
- 更多表情/动画（excited/tired/love/working、任务动画）。
- 成长与纪念日、多角色/皮肤体系。
- SQLite/数据库层与 migration 框架。
- 打包发布（.dmg/.exe）、开机启动、自动更新。

## 4. 目标架构

```text
┌─────────────────────────────────────────────┐
│ Renderer：角色、气泡、状态面板、审批面板       │
└───────────────────┬─────────────────────────┘
                    │ IPC 白名单
┌───────────────────▼─────────────────────────┐
│ Electron Main：窗口、会话编排、权限、事件总线   │
├──────────┬───────────┬───────────┬──────────┤
│ 情感核心  │ 记忆服务   │ 日程服务   │ LLM 网关 │
└──────────┴───────────┴───────────┴────┬─────┘
                                        │ 任务协议
┌───────────────────────────────────────▼─────┐
│ Agent Worker：计划、工具调用、超时和任务日志    │
├────────────┬─────────────┬──────────────────┤
│ 只读系统工具 │ 文件工具     │ Shell/代码工具    │
└────────────┴─────────────┴──────────────────┘
                    │
┌───────────────────▼─────────────────────────┐
│ 本地存储：设置、状态、记忆、任务、日程、审计日志 │
└─────────────────────────────────────────────┘
```

### 4.1 进程边界

Renderer 负责：

- 角色和动画。
- 气泡和聊天输入。
- 状态、记忆、日程、任务和审批界面。
- 不直接访问文件系统或执行命令。

Electron Main 负责：

- BrowserWindow 生命周期。
- IPC 参数校验。
- 对话编排。
- 权限判断和审批状态。
- 情感、记忆、日程服务协调。
- 启动和终止 Agent Worker。

Agent Worker 负责：

- 执行 Agent 计划。
- 调用系统、文件和代码工具。
- 超时、取消、输出限制和资源限制。
- 不拥有修改权限规则的能力。

## 5. 建议目录结构

```text
src/
├── main/
│   ├── main.js
│   ├── preload.js
│   ├── ipc.js
│   ├── event-bus.js
│   └── approval-service.js
├── renderer/
│   ├── index.html
│   ├── renderer.js
│   ├── style.css
│   └── panels/
├── conversation/
│   ├── orchestrator.js
│   ├── history.js
│   ├── intent-router.js
│   └── prompt-builder.js
├── emotion/
│   ├── state-service.js
│   ├── reducer.js
│   ├── decay.js
│   └── behavior.js
├── memory/
│   ├── memory-service.js
│   ├── retrieval.js
│   ├── summarizer.js
│   └── retention.js
├── scheduler/
│   ├── scheduler-service.js
│   ├── parser.js
│   └── reminder-runner.js
├── agent/
│   ├── worker.js
│   ├── planner.js
│   ├── executor.js
│   ├── task-service.js
│   └── tools/
│       ├── registry.js
│       ├── system-read.js
│       ├── files-read.js
│       ├── files-write.js
│       ├── shell.js
│       └── security-scan.js
├── storage/
│   ├── database.js
│   ├── migrations/
│   └── repositories/
└── core/
    ├── personality.json
    ├── llm-providers.json
    ├── emotion-rules.json
    └── settings-schema.json
```

目录可按阶段逐步建立，不要求一次性迁移全部现有代码。

## 6. 核心数据模型

### 6.1 情感状态

```json
{
  "mood": "calm",
  "affection": 30,
  "energy": 80,
  "health": 100,
  "stress": 10,
  "loneliness": 5,
  "updatedAt": "2026-08-07T10:00:00+08:00"
}
```

约束：

- 数值范围统一为 0～100。
- 状态变更必须通过 reducer，不允许业务代码任意改值。
- 时间衰减按最后更新时间计算，不使用高频定时器持续写盘。
- 好感每日增减应有上限，重复输入不得无限刷分。

### 6.2 情感事件

```json
{
  "type": "USER_PRAISE",
  "source": "conversation",
  "delta": {
    "mood": 5,
    "affection": 2,
    "stress": -1
  },
  "createdAt": "2026-08-07T10:00:00+08:00"
}
```

首批事件：

- `USER_GREETING`
- `USER_PRAISE`
- `USER_THANKS`
- `USER_NEGATIVE`
- `TASK_COMPLETED`
- `TASK_FAILED`
- `LONG_IDLE`
- `GOOD_NIGHT`
- `APP_STARTED`

### 6.3 记忆条目

```json
{
  "id": "mem_001",
  "type": "preference",
  "content": "用户喜欢喝美式咖啡",
  "importance": 7,
  "confidence": 0.92,
  "source": "conversation",
  "sensitivity": "private",
  "createdAt": "2026-08-07T10:00:00+08:00",
  "lastAccessedAt": "2026-08-07T10:00:00+08:00",
  "expiresAt": null
}
```

记忆类型：

- `profile`：姓名、称呼、稳定资料。
- `preference`：喜好和习惯。
- `episodic`：发生过的事件。
- `relationship`：共同经历和感受。
- `work`：项目、任务和工作上下文。
- `schedule`：日程相关信息。

### 6.4 Agent 任务

```json
{
  "id": "task_001",
  "title": "运行项目测试",
  "status": "pending_approval",
  "riskLevel": "L2",
  "plan": [],
  "workingDirectory": "/absolute/project/path",
  "timeoutMs": 120000,
  "networkAccess": false,
  "createdAt": "2026-08-07T10:00:00+08:00"
}
```

任务状态：

```text
draft
→ pending_approval
→ queued
→ running
→ completed | failed | cancelled
```

### 6.5 日程

```json
{
  "id": "schedule_001",
  "title": "项目会议",
  "type": "reminder",
  "runAt": "2026-08-08T09:00:00+08:00",
  "repeatRule": null,
  "enabled": true,
  "quietHoursPolicy": "respect",
  "createdFrom": "conversation"
}
```

## 7. 权限与风险模型

| 级别 | 行为 | 默认策略 |
|---|---|---|
| L0 | 时间、角色状态、应用内部数据 | 直接执行 |
| L1 | CPU、内存、磁盘、指定目录只读 | 首次授权后执行 |
| L2 | 创建文件、创建提醒、运行项目测试 | 每个任务展示计划并确认 |
| L3 | 删除、安装、外发、管理员权限、系统设置 | 每次强制确认 |

硬性规则：

- L3 不允许永久免确认。
- 白名单必须匹配工具、参数结构和作用范围，不能只匹配命令字符串。
- Shell 工具必须使用明确的工作目录。
- Shell 必须有超时和输出上限。
- 默认禁止 Agent 访问工作目录以外的文件。
- 默认禁止 Agent 外网访问。
- 删除默认进入废纸篓或隔离区。
- 审批记录和实际执行参数必须同时保存。

## 8. 对话编排规格

目标调用链：

```text
输入校验
→ 读取短期历史
→ 检索相关长期记忆
→ 读取当前情感状态
→ 意图分类
   ├─ 本地规则
   ├─ 普通聊天
   ├─ 记忆操作
   ├─ 日程操作
   └─ Agent 任务
→ 生成回复或任务计划
→ 保存会话
→ 更新情感事件
→ 按策略提取长期记忆
```

普通聊天的 LLM 上下文顺序：

1. 固定人格 system prompt。
2. 当前情感状态和行为约束。
3. 检索到的长期记忆。
4. 最近多轮对话。
5. 当前用户输入。

约束：

- 长期记忆必须标明为“可能相关的历史信息”，避免模型把低置信度内容当事实。
- 敏感记忆不得写入日志。
- Prompt 必须设定最大字符或 token 预算。
- 模型生成的工具参数必须经过 Schema 校验。

## 9. UI 规格

### 9.1 保留现有交互

- 单击打招呼。
- 双击聊天。
- 拖动角色移动窗口。
- 右键打开可拖动菜单。

### 9.2 新增面板

状态面板：

- 心情、好感、精力和健康。
- 当前状态产生原因。
- 主动互动开关。

记忆面板：

- 查看记忆。
- 按类型过滤。
- 删除单条记忆。
- 清空记忆。
- 设置“不要记住这类内容”。

任务面板：

- 待审批、执行中、完成、失败任务。
- 展示任务计划和风险级别。
- 允许批准、拒绝、取消和查看日志。

日程面板：

- 今日提醒。
- 新建、编辑、启用、暂停和删除日程。
- 设置安静时间。

### 9.3 交互约束

- 所有面板可拖动并限制在窗口可见区域。
- 面板默认避免遮住角色主体。
- 高风险审批不能仅依赖气泡完成。
- 执行中任务必须始终提供取消入口。

## 10. 执行阶段

### Phase 0：基础重构与可测试性

目标：在不改变现有用户行为的前提下建立后续模块边界。

任务：

- 将 `main.js` 中 IPC 注册拆到 `main/ipc.js`。
- 新建对话 orchestrator，将 `sendChat()` 从窗口代码中分离。
- 建立统一错误对象和日志格式。
- 建立 storage adapter。
- 对 SQLite 方案做兼容性验证，优先使用 Electron 当前 Node 可直接支持的实现。
- 增加 `npm run check`。
- 为规则引擎、情感 reducer 和权限策略建立测试骨架。
- 保持现有 UI、Provider 和对话行为不变。

交付物：

- 清晰的模块目录。
- 数据库初始化和 migration 机制。
- 最小测试脚本。
- 当前功能回归清单。

验收标准：

- 应用可以正常启动。
- 单击、双击、拖动、菜单和 LLM 对话不回归。
- 数据库首次启动可自动创建。
- IPC 不允许未声明的方法。
- `npm run check` 成功。

### Phase 1：情感、好感和健康状态

目标：让角色状态跨重启持续，并真实影响表现。

任务：

- 实现状态 reducer。
- 实现时间衰减。
- 实现情感事件日志。
- 将状态注入 LLM prompt。
- 将状态映射到 idle、happy、sad 表情。
- 增加状态面板。
- 增加主动互动和情绪表达开关。

首版只启用：

- mood
- affection
- energy
- health
- stress
- loneliness

验收标准：

- 状态数值始终在 0～100。
- 重启应用后状态保持。
- 相同重复文本不会无限增加好感。
- 状态变化可查询原因。
- 好感不会影响系统权限。
- 关闭情绪化表达后仍可正常执行管家任务。

### Phase 2：多轮对话与长期记忆

目标：角色能理解连续对话，并记住用户明确或高价值的信息。

任务：

- 保存最近对话历史。
- 给对话设置上下文窗口上限。
- 实现记忆增删查。
- 首版使用关键词、类型和重要度检索。
- 实现“记住这个”“不要记住”“忘记这件事”。
- 增加记忆面板。
- 实现低重要度记忆的归档或过期机制。

首版不要求：

- 向量数据库。
- 自动保存每一句对话。
- 复杂知识图谱。

验收标准：

- 能正确回答最近几轮对话中的指代问题。
- 用户明确要求记住的信息可跨重启查询。
- 用户可以删除单条和全部记忆。
- 删除后该记忆不会再次进入 prompt。
- 敏感记忆不会出现在普通调试日志中。

### Phase 3：只读 Agent 与电脑体检

目标：先建立安全工具调用链，不执行任何修改操作。

首批工具：

- `getSystemStats`
- `getDiskUsage`
- `listProcesses`
- `getNetworkConnections`
- `listDirectory`
- `readTextFile`
- `getGitStatus`

任务：

- 建立工具注册表和 JSON Schema。
- 建立意图路由和任务计划结构。
- 建立独立 Agent Worker。
- 增加超时、取消和输出截断。
- 增加只读目录授权。
- 增加任务面板和日志展示。
- 生成电脑体检报告。

验收标准：

- 未注册工具不能执行。
- 路径超出授权范围时被拒绝。
- 长时间命令会超时终止。
- 用户可以取消正在执行的任务。
- 体检报告区分“事实”“建议”“无法判断”。
- 系统诊断不得直接宣称发现病毒。

### Phase 4：日程、提醒与克制的主动性

目标：支持自然语言提醒和可控的主动管家行为。

任务：

- 新建、修改、删除和暂停提醒。
- 支持一次性和重复提醒。
- 支持时区和安静时间。
- 支持错过提醒后的补发策略。
- 支持久坐、深夜和磁盘不足提醒。
- 增加主动打扰频率限制。
- 增加日程面板。

验收标准：

- 重启后日程仍存在。
- 重复提醒不会被重复注册。
- 安静时间内不弹出普通提醒。
- 用户可以完全关闭主动提醒。
- 到期任务执行一次且有记录。

### Phase 5：受控写操作和代码 Agent

目标：允许 Agent 在用户授权的项目目录中完成实际工作。

首批工具：

- `createDirectory`
- `createTextFile`
- `applyPatch`
- `moveToTrash`
- `runProjectCommand`
- `openApplication`

任务：

- 建立 L2/L3 审批面板。
- 建立命令工作目录限制。
- 建立网络开关。
- 建立命令超时、输出限制和终止逻辑。
- 文件修改前生成 diff 或预览。
- 删除使用废纸篓，不直接永久删除。
- 执行结果写入任务日志和工作记忆。

首版禁止：

- 无确认的任意 Shell。
- 管理员权限。
- 修改系统目录。
- 自动发送邮件或对外发布内容。
- 自动安装未知依赖。

验收标准：

- 每个写操作显示实际目标。
- 用户拒绝后不产生修改。
- 文件修改可以看到 diff。
- 任务可以取消并正确结束子进程。
- Agent 无法自行改变权限策略。
- 好感度变化不会跳过审批。

### Phase 6：安全扫描与隔离区

目标：提供可信的安全辅助能力，不冒充完整杀毒软件。

任务：

- 区分系统体检、安全审计和恶意文件扫描。
- 集成可选 ClamAV 或 YARA 扫描器。
- 支持指定目录扫描。
- 记录文件路径、哈希、命中规则和扫描时间。
- 建立白名单。
- 建立隔离区和恢复功能。
- 删除隔离文件必须二次确认。

验收标准：

- 默认扫描只读。
- 扫描结果说明来源和置信度。
- 可疑文件不会被自动永久删除。
- 隔离文件可以恢复到原路径或指定路径。
- 扫描器不可用时给出明确提示。
- 不把高 CPU、未知进程等单一现象直接判定为病毒。

### Phase 7：角色表现、成长与发布

目标：把前述能力统一为完整桌宠体验。

任务：

- 增加 excited、tired、love、working 等状态。
- 增加任务执行和提醒动画。
- 增加每日总结和共同事件回顾。
- 增加纪念日和成长内容。
- 增加多角色或皮肤扩展接口。
- 完善 macOS/Windows 打包。
- 增加崩溃恢复和数据备份。

验收标准：

- 动画不会阻塞交互。
- 用户可以关闭成长和纪念日功能。
- 数据升级不丢失记忆和日程。
- 打包版本保留与开发版本一致的权限策略。

## 11. IPC 草案

现有 `window.desktopPet` 接口保留，新增接口按领域分组：

```text
desktopPet.state.get()
desktopPet.state.getHistory()

desktopPet.memory.list(filter)
desktopPet.memory.create(input)
desktopPet.memory.remove(id)
desktopPet.memory.clear()

desktopPet.tasks.list(filter)
desktopPet.tasks.approve(id)
desktopPet.tasks.reject(id)
desktopPet.tasks.cancel(id)
desktopPet.tasks.getLog(id)

desktopPet.schedule.list()
desktopPet.schedule.create(input)
desktopPet.schedule.update(id, input)
desktopPet.schedule.remove(id)

desktopPet.settings.get()
desktopPet.settings.update(patch)
```

所有 IPC 输入必须：

- 校验类型和字段。
- 限制字符串长度。
- 校验绝对路径和授权范围。
- 返回统一错误结构。

统一错误结构：

```json
{
  "ok": false,
  "error": {
    "code": "PATH_NOT_ALLOWED",
    "message": "该路径不在授权范围内",
    "recoverable": true
  }
}
```

## 12. 存储与迁移

存储内容：

- `settings`
- `emotion_state`
- `emotion_events`
- `conversations`
- `messages`
- `memories`
- `tasks`
- `task_logs`
- `schedules`
- `approvals`
- `scan_results`

要求：

- 数据库必须带 schema version。
- 每次结构变更通过 migration 完成。
- 启动前备份关键数据库。
- 用户可以导出和删除全部个人数据。
- API Key 不进入普通数据库和日志，优先使用系统安全存储。

## 13. 测试策略

单元测试：

- 情感 reducer 和边界值。
- 时间衰减。
- 记忆检索和删除。
- 权限等级判断。
- 路径授权。
- 日程下一次执行时间。
- 工具参数 Schema。

集成测试：

- 对话历史进入 prompt。
- 记忆新增、检索和删除完整链路。
- Agent 计划、审批、执行和日志链路。
- Worker 超时和取消。
- 日程重启恢复。
- 扫描、隔离和恢复。

手动回归：

- 角色点击、双击和拖动。
- 气泡和表情。
- 右键菜单和子菜单。
- Provider 切换。
- LLM 不可用时的错误展示。
- 面板拖动和边界限制。

## 14. 可观测性

日志至少包含：

- 时间。
- 模块。
- taskId 或 conversationId。
- 操作名称。
- 成功、失败或取消状态。
- 耗时。

日志不得包含：

- API Key。
- 完整敏感记忆。
- 未经脱敏的文件内容。
- 用户密码或认证令牌。

## 15. Definition of Done

每个 Phase 完成必须同时满足：

1. 功能实现并有明确 UI 入口或对话入口。
2. 数据可以跨重启恢复。
3. 权限和错误路径经过测试。
4. 不破坏现有角色交互和 LLM 对话。
5. 新增配置有默认值和迁移逻辑。
6. 文档与实际行为一致。
7. 不留下无法取消的后台任务。
8. 不记录敏感信息。

## 16. 推荐立即执行的第一个里程碑

第一个里程碑限定为 Phase 0 + Phase 1 的最小闭环：

```text
模块拆分
→ 状态持久化
→ 情感 reducer
→ 状态注入 LLM
→ 表情联动
→ 状态查看面板
```

这个里程碑完成后，小未来应具备：

- 跨重启保存的心情、好感、精力和健康。
- 可追溯的状态变化原因。
- 状态影响对话语气和表情。
- 不依赖 Agent 权限即可形成明显的“生命感”。

完成该里程碑后，再进入长期记忆，避免同时改动对话、存储、Agent 和 UI 导致范围失控。
