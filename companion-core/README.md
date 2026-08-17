# Python Companion Core

小未来的 Python 领域后端。它通过 stdin/stdout 的 JSON Lines RPC 与 Electron 主进程通信，不监听网络端口，也不直接操作窗口、文件权限或外部工具。

当前实现验证了启动、状态持久化、感知事件摄取和受管关闭。它只依赖 Python 标准库。生活模拟、记忆、情绪和日记将在后续阶段迁入这个进程。

## 协议

请求：

```json
{"id":"node:1","method":"core.bootstrap","params":{"dataDir":"/path/to/userData"}}
```

响应：

```json
{"id":"node:1","ok":true,"result":{"schemaVersion":1}}
```

支持 `core.bootstrap`、`core.health`、`core.snapshot`、`event.ingest` 和 `core.shutdown`。协议版本由后续共享契约文件统一管理；任何不兼容修改都必须提升版本。
