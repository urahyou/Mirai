# AGENTS.md

Electron 桌宠「小未来」——类似伪春菜 (Ukagaka) 的透明悬浮桌面字符，对话由本地大模型驱动。

## 常用命令

- 启动：`npm start`
- 开发调试（打印渲染进程 console、开 DevTools）：`npm run dev`
- 无 lint / typecheck 脚本；`npm run check` 执行语法检查和 `node:test`，另外可启动 Electron 观察控制台。

## 架构（非直觉，务必先读）

- 入口：`src/main/main.js`（主进程：窗口、IPC、对话调度、provider 状态）
- 渲染进程 `src/renderer/`：纯 Live2D 角色 Canvas、气泡、拖拽、**右键 HTML 菜单**（托盘已移除，勿再加 Tray）
- 安全桥接 `src/main/preload.js`：所有 IPC 经 `desktopPet.*` 暴露，渲染进程不直接 require。

对话调度（`main.js` 的 `chat:submit`）：
1. 输入消息写入 `userData/chat-history.json`
2. 全部走 `src/engine/generic.js` 调 OpenAI 兼容大模型（按 provider 优先级自动回退）
3. 通过 `chat:delta` 同时推送角色气泡和聊天窗口的流式回复
4. 回复完成后写入聊天历史

角色交互（`main.js` 的 `character:greet`）是独立的单句点击回应，会写入聊天记录，但不会进入正式多轮 LLM 上下文。

> 本地规则关键词答话已移除（无 `dialogueMode` 概念），对话一律走大模型。

## 配置（不要硬编码进代码）

- `src/core/llm-providers.json`：**不含密钥的 Provider 出厂模板**。实际配置写入 Electron `userData/llm-providers.runtime.json`；API Key 只从项目根目录 `.env` 的 `apiKeyEnv` 变量读取，勿把密钥写入仓库。
  - 仓库默认配置以 `src/core/llm-providers.json` 为准，当前激活项可能是本机 Ollama；不要在文档或代码中写死地址、模型或密钥。
  - `isAvailable()` 探测 `/models` 端点；对应 `.env` 变量为空时不加 Authorization 头。
- `src/core/personality.json`：角色出厂人格（只读默认）。`systemPrompt` 中的 `{personality}` 会被替换成整个 personality 对象注入给大模型。
  - 用户编辑的人格覆盖存 userData `personality-runtime.json`（深合并到出厂之上）。当前没有独立主人资料或 owner 服务。
- 可选 TiMem 长期记忆通过 `src/services/timem-memory.js` 接入；`TIMEM_ENABLED` 默认关闭，密钥仅从本机 `.env` 读取。检索结果只作为 Prompt 参考资料，TiMem 不可用时必须降级为无长期记忆的本地聊天。

## 关键坑（容易踩）

- **角色图**：角色完全由 `assets/live2d/` 下的 Cubism 模型渲染。点击命中必须使用 `Live2DAvatar.isHit()`，不要恢复 PNG fallback 或 alpha 图片命中缓存。模型纹理 PNG 是 Live2D 资源的一部分，不是旧角色 fallback。
- **macOS Gatekeeper**：旧版 Electron（如 31）公证被吊销，运行时报 `SIGKILL`/「包含恶意软件」。当前 Electron 43.3.0 正常。若再遇到该报错，是二进制下载不完整/公证吊销，不是代码问题。
- **Electron 二进制**：当前 Node 是 v20（brew `node@20`），而新版 Electron 下载工具 `@electron/get@5` 需 Node≥22。若 `npm start` 报 `ENOENT`/闪退，说明 `node_modules/electron/dist` 二进制缺失，需手动补（`path.txt` 内容为 `Electron.app/Contents/MacOS/Electron`）。
