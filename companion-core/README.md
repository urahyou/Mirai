# Python Companion Core

小未来的 Python 领域后端。它通过 stdin/stdout 的 JSON Lines RPC 与 Electron 主进程通信，不监听网络端口，也不直接操作窗口、文件权限或外部工具。

当前实现覆盖启动、状态持久化、感知事件摄取、宠物情绪/养成兼容状态、规则化虚拟生活、多维情绪投影和本地 SQLite 记忆基础。它只依赖 Python 标准库；日记生成和计划器仍在后续阶段。

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
- Memory：情景 `memory.add_episode`/`memory.search`，语义事实 `memory.upsert_fact`/`memory.find_facts`，画像 `memory.upsert_profile`/`memory.get_profile`，关系图 `memory.upsert_edge`/`memory.neighbors`，以及来源级删除 `memory.forget_source`。

事实与关系边可引用一条已存情景记忆作为 `sourceId`；来源被删除时，引用它的事实和关系会一并删除。协议版本由后续共享契约文件统一管理；任何不兼容修改都必须提升版本。
