# 小未来 — 记忆系统升级：方案 C（分层记忆 + 反思压缩）设计

> 状态：设计定稿，P1（分层骨架）+ P2（自动沉淀 Memory Judge）+ P3（反思压缩）均**已完成并在真实环境验证通过**；UI 重设计 U1（菜单分组+自动记忆开关）+ U3（记忆库）已完成。
>
> **P2 实跑验证记录（真实 deepseek `deepseek-v4-flash`）**：
> - 长期偏好「我最近开始学做饭，最爱做番茄炒蛋」→ Judge 正确提炼写 `active/preference`（imp=0.4，低权重落 archival 而非 core）✔
> - 一次性行程「我明天晚上要做飞机去北京出差」→ Judge 保守判定 `candidate count: 0`，不记（不把一次性状态写成长期偏好）✔
> - GUI 实际对话「我周末喜欢去爬山」→ 自动 Judge 写入 `active/preference`（imp=0.6），持久化到 userData `memory.json`（schema v2，旧数据保留）✔
> - **修复两个真实 bug**：① 绝对化过滤把量词「是只橘猫」的「只」误当绝对副词，导致候选误杀 → 改为「绝对词需在用户原话出现过才放行」；② main.js `scheduleAutoMemory` 传 `reply` 而 `run` 解构 `assistantReply`，参数名不匹配导致 GUI 恒 `hasReply:false` 不记忆 → 对齐为 `assistantReply`。
> - 测试：58 pass / 0 fail（含新增量词豁免回归用例）。
> 基线：现有命令式记忆（`services/memory-*.js`）+ 多轮 history（`engine/generic.js` 12 轮）
> 参考：Letta/MemGPT（分层记忆）、Cyrene-Agent `memory-*`（L0/L1/L2、Judge 提炼、反思压缩、冲突解决）、mem0（LLM 抽取）

---

## 1. 背景与目标

### 1.1 现状痛点

1. **记忆全靠命令**：普通对话不自动记，必须主人明说「记住XX」，小未来自己不会"沉淀"相处经验。
2. **无分层**：所有记忆扁平存放、一视同仁，低价值信息和高价值画像混在一起。
3. **检索朴素**：仅关键词包含匹配（`includes`），无法语义召回，也不能区分"近期要紧 vs 长期稳定"。
4. **只增不汰**：无压缩/遗忘机制，记忆只堆叠不筛选，长期会膨胀、失效信息滞留。

### 1.2 方案 C 目标

把小未来的记忆升级为 **三层结构 + 自动沉淀 + 反思压缩**：

| 目标 | 说明 |
|---|---|
| 分层 | core（常驻画像）/ working（会话相关）/ archival（全量长期） |
| 自动沉淀 | 对话后 LLM 自己判断有无值得记的，自动写入 |
| 反思压缩 | 旧的低热度记忆定期压成摘要，精华留存、膨胀受控 |
| 兼容 | 不动现有命令式记忆、情感、人格；JSON 存储 schema 增量迁移 |
| 克制 | 优先"少记错"，采用保守过滤（宁可漏记，不要误记） |

### 1.3 范围（P1–P3）

- P1 分层骨架：schema v2 + core/archival + working 注入改造
- P2 自动沉淀：Memory Judge 来源层
- P3 反思压缩：调度器
- P4（后置、可选）：向量召回 + 冲突演化 —— **不纳入本次范围**，本文仅预留字段。

> 本次 P1–P3 **不引入任何新依赖**：纯 LLM（走现有 `generic.js`）+ 现有 JSON 存储，完全离线可跑。

---

## 2. 分层模型

| 层 | 含义 | 存储 | 注入方式 | 生命周期 |
|---|---|---|---|---|
| **Core 核心** | 称呼、稳定身份、长期偏好、核心关系 | `owner.json` + 标 `status=core` 的高价值记忆 | **常驻 system prompt**（始终在） | 长期稳定 |
| **Working 工作** | 本次会话相关的高价值记忆 | 运行时计算，不落盘 | **动态检索** topK，随输入更换 | 单次请求 |
| **Archival 归档** | 全量长期记忆（含普通 + 压缩摘要） | `memory.json` 扩展字段 | **不常驻**，仅检索召回 | 主动衰减/压缩 |

### 2.1 现有字段映射

现有记忆已具备 `type / content / importance / confidence / source / sensitivity / createdAt / lastAccessedAt / expiresAt / archivedAt`。
本设计在其上**增量扩展**，不改动既有字段语义，保证 `memory.test.js` 等既有行为不被破坏。

### 2.2 归属规则（新记忆进哪层）

| 判定 | 去向 |
|---|---|
| 稳定身份 / 称呼 / 长期口味兴趣（`certainty=explicit` + `stability=stable` + 高 importance） | **Core** |
| 事件 / 局部偏好 / 待观察信息（其余） | **Archival** |
| 一次性 / 无依据推断 / 过度概括 | **不写**（被 Judge 挡住） |

---

## 3. 数据模型（`memory-store.js` schema v1 → v2）

### 3.1 新增字段

```js
{
  // ...既有字段：id, type, content, importance, confidence, source, sensitivity,
  //     createdAt, lastAccessedAt, expiresAt, archivedAt

  status: 'active' | 'aging' | 'archived' | 'compressed' | 'core', // 分层/状态标记
  weight: 0.7,             // 热度 = importance + 访问增幅；决定升 core / 触发压缩
  accessCount: 0,          // 被检索次数；防误压缩高频记忆
  embedding: undefined,    // 预留（P4 向量，本次不启用）
  isSummary: false,        // 是否为反思压缩生成的摘要条
  subEntryIds: [],         // 被本条压缩的原始记忆 id（可溯源）
  conflictWith: []         // 预留（P4 冲突标记，本次不启用）
}
```

### 3.2 `json-storage.js` 迁移

`createJsonStorage` 已支持 `migrate({ schemaVersion, data })`，升级为 v2 时：
- 旧记忆补默认 `status:'active'`、`weight=importance||0.5`、`accessCount:0`、`isSummary:false`、`subEntryIds:[]`、`conflictWith:[]`

### 3.3 状态机

```
active ──访问热度高 / Judge 提升──▶ core
active ──热度衰减──▶ aging ──低热度且久未访问──▶ (待压缩) ──▶ compressed（原始条）
compressed ←─ summary 条生成，subEntryIds 指回原始条
任何层 ──用户忘记/删除　或　过期──▶ archived（彻底归档）
```

---

## 4. 来源层：自动沉淀（Memory Judge，P2）

### 4.1 触发

`sendChat` 拿到 `user+assistant` 完整回复后，**后台异步**调用一次 Judge（不阻塞对话、不进聊天队列）。

### 4.2 Judge Prompt 要点（新增 `memory-judge.js`）

> 你是一个**保守的记忆候选提取器**，不是事实裁判，也不是用户画像改写器。
> 只提取用户明确表达、且未来确实有帮助的信息。宁可漏记，不要误记。
> - 纯闲聊 / 情绪发泄（无信息量）→ 返回空 candidates
> - 必须是**用户主动表达**的信息，不是 AI 说的
> - 禁止把推断写成确定事实；禁止把一次性状态写成长期偏好
> - 绝对化措辞（只/永远/从不/一定）除非用户原话说过，否则判为过度概括并挡掉
> 输出 candidates[] 各含：`type / content / importance(0~1) / confidence(0~1) / stability(one_off|situational|stable) / certainty(explicit|inferred|uncertain) / shouldWrite / reason`

### 4.3 业务后处理（对齐 Cyrene `postFilterCandidates`）

- 仅保留 `shouldWrite === true`
- 进 Core 必须 `certainty=explicit`（无依据推断只能进 archival，或丢弃）
- 存在 overclaim 词且用户没原话 → 丢弃
- 无信息量（问候/纯抒发）→ 整体空

### 4.4 写入

- 判断归属层后，调用扩展后的 `memoryService.remember(...)`
- 关键：Judge 是**后台异步**，失败/超时静默，绝不影响主对话响应

---

## 5. 注入策略（`generic.js` 改造）

现有 `buildBasePrompt({ system, emotionState, memoryContext })` 只收一段。改为：

```js
buildBasePrompt({ system, emotionState, memory: { core, working } })
```

- **core**：`owner.json` 称呼铁律 + `status=core` 的记忆（常驻，预算 ≤800 字）
- **working**：按当前输入召回 topK 的匹配记忆（预算单独 ≤1200 字）
- 两段都以「可能相关的历史信息，仅供参考，别编造」为注脚（沿用现有措辞）
- 上下文顺序不变：systemPrompt → 称呼铁律 → 情感 → core → working → 最近 12 轮历史 → 当前输入

`main.js` 的 `memoryContextFor(input)` 升级为 `buildMemoryLayers(input)` 返回 `{ core, working }`。

---

## 6. 反思压缩调度器（P3，本方案核心亮点）

新文件 `memory-reflection.js`。

### 6.1 触发器

- 复用 main.js 现有定时机制（`setInterval`，与 `reminderTimer` 同款）
- 每日一次 + 每累计 N 轮对话触发一次

### 6.2 选材

`archival`/`active` 中同时满足：
- `weight` 低（热度低）
- `lastAccessedAt` 距今久（久未命中）
- 同类（同 `type`）优先，便于压成连贯摘要
- **保护**：`accessCount` 高、`status=core`、`isSummary` 摘要条本身不被压缩

### 6.3 压缩动作

- 把选中的 N 条交给 LLM 压缩成 1 条 summary（`isSummary:true`）
- 原始 N 条标 `status='compressed'`（不再参与普通召回）
- summary 记录 `subEntryIds` 指向原始条，保留可溯源
- 写 `reflectionLogs`（P3 可选）便于审计

### 6.4 效果

- 长期记忆**只沉淀精华、不膨胀**
- 冷门细节被折叠，但能通过 summary 回忆轮廓；摘要条被语义召回后，可顺带揭示原始条存在

---

## 7. 兼容性与既有行为保障

- `memory-service.js` 对外函数签名不变（`remember/list/retrieve/forget/...`），仅内部扩展与新增 `promoteToCore / decayWeight / reflect` 等
- 命令式「记住/忘记/回查」保持原样
- 情感、人格、抓取历史逻辑不动
- schema 迁移走 `json-storage.js` 既有 `migrate()`
- 既有 `test/*` 不破坏；为新增逻辑补测试（见 §10）

---

## 8. 改造文件清单

| 文件 | 变更 |
|---|---|
| `src/services/memory-store.js` | schema v2：新增字段 + 默认值 + migrate |
| `src/services/memory-service.js` | weight/accessCount 更新、core 筛选、ranking、promote/decay、reflect 基础 |
| `src/engine/generic.js` | `buildBasePrompt` 支持 `{core, working}` 两段注入 |
| `src/main/main.js` | `memoryContextFor→buildMemoryLayers`；启动定时；sendChat 后挂 Judge（P2） |
| `src/services/memory-judge.js`（新增） | LLM 自动提炼（P2） |
| `src/services/memory-reflection.js`（新增） | 反思压缩调度（P3） |
| `test/` | 新增 memory-layered / memory-judge / memory-reflection 测试 |

---

## 9. 分阶段计划

| 阶段 | 内容 | 范围 |
|---|---|---|
| **P1** | schema v2 + core/archival 分层 + working 注入改造 | 本文 §3 §5 |
| **P2** | Memory Judge 自动沉淀 | §4 |
| **P3** | 反思压缩调度 | §6 |
| P4（可选） | 向量召回（embedding）+ 冲突演化（conflictWith） | 预留，不在本次 |

每阶段结束跑 `npm run check` 验证既有 48 用例不回归，并新增对应测试。

---

## 10. 测试计划

- `memory-layered.test.js`：core/working/archival 归属、weight 升降、decay、promote
- `memory-judge.test.js`：Judge 后处理过滤（过度概括/绝对化/inferred）、空信息量返回空
- `memory-reflection.test.js`：选材保护（高 accessCount 不压）、summary 生成、subEntryIds 溯源
- 既有 `memory.test.js` 保持通过

---

## 11. 风险与取舍

| 风险 | 对策 |
|---|---|
| Judge 额外 LLM 调用增加开销 | 后台异步、可配置频率；LLM 不可用静默 |
| 记忆丢失/误判 | 保守过滤优先；压缩条可溯源（subEntryIds）；面板可清空/导出 |
| 系统记忆膨胀 | 反思压缩 + weight 衰减自平衡 |
| 复杂度上升 | 层层解耦；不引入向量库；分阶段交付 |
