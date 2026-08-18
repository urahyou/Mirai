# Python Companion Core

小未来的 Python 领域后端。它通过 stdin/stdout 的 JSON Lines RPC 与 Electron 主进程通信，不监听网络端口，也不直接操作窗口、文件权限或外部工具。

当前实现覆盖启动、状态持久化、感知事件摄取、宠物情绪/养成兼容状态、规则化虚拟生活、多维情绪投影、本地 SQLite 记忆和可追溯的日记素材。它只依赖 Python 标准库；日记正文生成和计划器仍在后续阶段。

## 协议

请求：

```json
{"id":"node:1","method":"core.bootstrap","params":{"dataDir":"/path/to/userData"}}
```

响应：

```json
{"id":"node:1","ok":true,"result":{"schemaVersion":1}}
```

支持的方法分为：

- Core：`core.bootstrap`、`core.health`、`core.snapshot`、`event.ingest`、`core.shutdown`
- Pet：`pet.get_state`、`pet.apply_event`、`pet.seed_if_empty`
- Life：`life.get_state`、`life.advance`、`life.perform_activity`。所有购物和物品变动只作用于虚拟状态，不会调用系统支付或外部服务。
- Emotion：`emotion.get_state`。情绪仅由宠物互动和已完成的虚拟生活活动更新，并按时间向基线衰减。
- Memory：情景 `memory.add_episode`/`memory.search`，有界混合检索 `memory.retrieve`，调用方提供 embedding 的 `memory.vector_upsert`/`memory.vector_search`，候选事实 `memory.extract_candidates`/`memory.list_candidates`/`memory.review_candidate`，正式语义事实 `memory.upsert_fact`/`memory.find_facts`，画像 `memory.upsert_profile`/`memory.get_profile`，关系图 `memory.upsert_edge`/`memory.neighbors`，以及分级遗忘 `memory.forget_source`（默认 faded）和明确物理删除 `memory.erase_source`。
- Journal：`journal.build_daily_material`/`journal.get_daily_material`、`journal.save_daily_prose` 与对应的 weekly 方法。素材仅汇总已保存聊天、明确互动事件和完成的虚拟活动，并保留来源 ID；日记正文只能在事实素材已落库后由用户触发生成并回写。

`memory.db` 当前 schema 版本为 5。原始聊天统一落在 `conversation_messages`，情景记忆 `episodes` 只保存摘要和来源引用，不复制逐句转录；旧版复制型聊天 Episode 会保留为 `archived/legacy` 供审计。Episode 中明确的主人陈述可以生成 `assertion_candidates`，候选默认是 `pending`，必须审核后才会写入 active assertion；冲突候选必须显式指定 `supersedesId`。语义事实和关系边统一存为带有效期的 assertion，关系图只是实体型 assertion 的投影；一条 assertion 可以由多条情景证据共同支撑。删除一个来源时只移除对应证据，最后一条证据消失后才删除该 assertion。

`memory.retrieve` 会把关键词命中的当前事实、聊天情景和最多一跳的图关系合并评分，最多返回 12 条；Electron 实际注入模型时进一步限制为 6 条、约 4.4k 字符。Core 可以保存调用方生成的向量，并按模型和维数执行有界余弦检索；它自身不选择、下载或运行 embedding 模型。默认聊天检索链路仍不开启向量通道，因此基础安装不增加模型或网络依赖。协议版本由后续共享契约文件统一管理；任何不兼容修改都必须提升版本。

`memory.forget_source` 默认只改变召回状态并写入 `memory_lifecycle`，保留原始消息、Episode 和证据用于审计；`toState=erased` 或单独调用 `memory.erase_source` 才会物理清理。
