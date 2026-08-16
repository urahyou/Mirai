# AGENTS.md

Electron 桌宠「小未来」——类似伪春菜 (Ukagaka) 的透明悬浮桌面字符，对话由本地大模型驱动。

## 常用命令

- 启动：`npm start`
- 一键语音（音色克隆）：`npm run setup:voice`（装 voice-sidecar 语音内核 venv+模型，若需本地音色则再装 GPT-SoVITS 进 `vendor/`）+ `npm run start:voice`（自动起 TTS 再开小未来）
- 开发调试（打印渲染进程 console、开 DevTools）：`npm run dev`
- 无 lint / typecheck 脚本；`npm run check` 执行语法检查和 `node:test`，另外可启动 Electron 观察控制台。

## 架构（非直觉，务必先读）

- 入口：`src/main/main.js`（主进程**纯装配**：按序创建各模块（窗口/语音/对话/气泡）→ 构造 api 胶囊 → `mountIpc(api)` 注册全部 IPC 能力域 → 应用生命周期；不保留任何具体实现）
- 主进程按职责拆分，以依赖注入创建（main.js 只做排序与注入）：
  - `src/main/window.js` 窗口辅助——windowOptions/主窗(桌宠)创建/置顶层级/显示应用/聊天输入窗/发送转发
  - `src/main/panel.js` 菜单窗 + 各设置面板
  - `src/main/voice.js` 语音朗读/识别/打断 + 语音 IPC
  - `src/main/chat.js` 对话调度（handleUserUtterance/generateChat/上下文预算/聊天 IPC）
  - `src/main/balloon.js` 独立气泡窗（创建/定位/渲染/隐藏）
  - `src/main/shared-state.js` 共享状态（mainWindow/chatInputWindow/isVoiceListening 等）
  - `src/subsystems/*.js` IPC 能力域——personality/display/voice/provider/context/memory/balloon/window/menu 各一个 `setup(api)` 注册自己的 ipcMain；main.js 只 `mountIpc(api)` 装配。**新增能力 = 在 subsystems/ 加一个 setup(api) 并在 index.js 注册即可**
  - `src/contracts/ipc.js` IPC 通道常量**单一事实源**（68 通道）；preload 因渲染沙箱无法 require 本地文件仍以字符串暴露，一致性由 `test/ipc-contract.test.js` 双向断言守住（并守卫 main.js 不再直接注册 IPC）
  - `src/services/dotenv.js` `.env` 解析/读写**唯一实现**（generic/sidecar-env/graphiti-memory/voice-bridge/start-all 均委托它；写策略=改已有 `KEY=` 行、追加新键、保留注释）
- 渲染进程 `src/renderer/`：纯 Live2D 角色 Canvas、气泡、拖拽、**右键 HTML 菜单**（托盘已移除，勿再加 Tray）
- 安全桥接 `src/main/preload.js`：所有 IPC 经 `desktopPet.*` 暴露，渲染进程不直接 require。

对话调度（`src/main/chat.js` 的 `chat:submit`）：
1. 输入消息写入 `userData/chat-history.json`
2. 全部走 `src/engine/generic.js` 调 OpenAI 兼容大模型（按 provider 优先级自动回退）
3. 通过 `chat:delta` 同时推送角色气泡和聊天窗口的流式回复
4. 回复完成后写入聊天历史

角色交互（`src/main/chat.js` 的 `character:greet`）是独立的单句点击回应，会写入聊天记录，但不会进入正式多轮 LLM 上下文。

> 本地规则关键词答话已移除（无 `dialogueMode` 概念），对话一律走大模型。

## 语音子系统（可选，Python 侧车）

语音输入/输出由一个**独立 Python 进程** `voice-sidecar/sidecar_server.py` 实现，与 Electron 主进程通过本机 WebSocket 通信：

- 主进程 `src/main/voice-bridge.js`：spawn 并守护侧车（崩溃自动重启、连接自愈重连），把 renderer 采集的 int16 PCM 转发给侧车，接收 `vad`/`asr`/`audio` 事件。
- **VAD/ASR 内核用本地独立包 `voice-sidecar/mirai_voice/`**（`vad.py`+`asr.py`，Silero VAD + Sherpa-ONNX/SenseVoice ASR）：跑在 Mirai 自己的 venv `voice-sidecar/.venv`（py3.13 独立，含 numpy/torch/silero-vad/sherpa-onnx/onnxruntime/edge-tts 等，由 `npm run setup:voice` 安装）；SenseVoice ASR 模型装到 `voice-sidecar/models/`（`fetch_models.py` 从官方 release 下载，全新环境一次配置）。
- TTS 引擎可切换（`.env` 里 `SIDECAR_TTS_ENGINE`）：`edge`（默认，云合成需联网）或 `gpt-sovits`（本地音色克隆，GPT-SoVITS API —— `SIDECAR_TTS_URL`/`SIDECAR_TTS_REF_WAV`/`SIDECAR_TTS_PROMPT_TEXT`/`SIDECAR_TTS_PROMPT_LANG` 等），后者 POST 到服务端 `/tts`（api_v2 字段 `ref_audio_path`/`text_lang`/`prompt_lang`），输出 wav、完全离线。
- **GPT-SoVITS 是独立服务、非 Mirai 进程**：由 `npm run setup:voice` 装入 `vendor/gpt-sovits/`（gitignore；本机已有 `~/GPT-SoVITS` 则软链复用、不重装），`start:voice` 自动拉起 api_v2.py（9880，Mac CPU 配置）等就绪再开小未来，退出时若由它拉起则一并关闭。
- 外语朗读（`SIDECAR_TTS_SPEAK_LANG`，如 `ja`）：发言前先把中文回复用 LLM 翻译成目标语言再合成朗读，屏幕气泡仍显示中文；译文语言要跟 `SIDECAR_TTS_TEXT_LANGUAGE` 一致（`main.js` 的 `speak()` + `engine/generic.js` 的 `translate()`）。
- 协议：客户端→侧车=二进制 int16 PCM(16k) 或 JSON `{type:'speak',text}`；侧车→客户端=JSON `ready/vad/asr/audio`。
- 音频只在 `127.0.0.1` 上传输，不上任何云端。

关键链路（语音在 `src/main/voice.js`、对话调度在 `src/main/chat.js`、聊天窗跟随在 `src/main/window.js`）：

1. 语音输入：`voice:pcm` → sidecar `asr-partial`/`asr` → 开着对话窗时填输入框（`chat-input.js` 决定是否自动发送），否则直接 `handleUserUtterance(text)`。
2. 语音输出：回复生成后自动 `speak(reply)` → sidecar 合成 MP3 → `voice:audio` 推给宠物窗 WebAudio 播放（带说话动画）；`voice:vad` `speech_start` 会打断正在播放的语音。
3. 共享状态：`isVoiceListening` 是主进程单一事实源，`voice:listening-changed`/`voice:status` 广播给两个窗口同步 `🎤` 按钮（绿=聆听中，橙=侧车加载中）。

侧车模型加载需 20–50 秒，`npm start` 时后台预热；就绪前识别不可用（`🎤` 橙色脉冲）。未就绪期间 PCM 缓存有限、可能丢弃，属预期。

`preload.js` 暴露的语音 API：`voice.start/stop/getStatus/sendPcm/setListening/onAsr/onVad/onAsrPartial/onAsrFinal/onListening/speak/onAudio/onSpeakInterrupt/onStatus`。

## 配置（不要硬编码进代码）

- `src/templates/llm-providers.json`：**不含密钥的 Provider 出厂模板**。实际配置写入 Electron `userData/llm-providers.runtime.json`；API Key 只从项目根目录 `.env` 的 `apiKeyEnv` 变量读取，勿把密钥写入仓库。
  - 仓库默认配置以 `src/templates/llm-providers.json` 为准，当前激活项可能是本机 Ollama；不要在文档或代码中写死地址、模型或密钥。
  - `isAvailable()` 探测 `/models` 端点；对应 `.env` 变量为空时不加 Authorization 头。
- `src/templates/personality.json`：角色出厂人格（只读默认）。`systemPrompt` 中的 `{personality}` 会被替换成整个 personality 对象注入给大模型。
  - 用户编辑的人格覆盖存 userData `personality-runtime.json`（深合并到出厂之上）。当前没有独立主人资料或 owner 服务。
- 长期记忆唯一使用 Graphiti + Neo4j，通过独立 Python sidecar 接入；Graphiti 不可用时降级为无长期记忆的本地聊天，不使用其他记忆服务。

## 工作偏好（用户明确要求，务必遵守）

- **上下文压缩阈值**：当对话上下文占用达到约 80% 时，自动进行压缩/紧凑摘要，不要等到接近上限。

## 关键坑（容易踩）

- **角色图**：角色完全由 `assets/live2d/` 下的 Cubism 模型渲染。点击命中必须使用 `Live2DAvatar.isHit()`，不要恢复 PNG fallback 或 alpha 图片命中缓存。模型纹理 PNG 是 Live2D 资源的一部分，不是旧角色 fallback。
- **macOS Gatekeeper**：旧版 Electron（如 31）公证被吊销，运行时报 `SIGKILL`/「包含恶意软件」。当前 Electron 43.3.0 正常。若再遇到该报错，是二进制下载不完整/公证吊销，不是代码问题。
- **Electron 二进制**：当前 Node 是 v20（brew `node@20`），而新版 Electron 下载工具 `@electron/get@5` 需 Node≥22。若 `npm start` 报 `ENOENT`/闪退，说明 `node_modules/electron/dist` 二进制缺失，需手动补（`path.txt` 内容为 `Electron.app/Contents/MacOS/Electron`）。
- **语音侧车**：侧车是独立 Python 进程，跑在 **Mirai 自己的 `voice-sidecar/.venv`**（py3.13 独立环境，含 silero-vad/sherpa-onnx/torch/edge-tts 等；`npm run setup:voice` 一次安装）。模型预加载需 20–50 秒；测试后请 `pkill -f sidecar_server.py` 清理残留进程，避免占用端口。若本机直连 pypi.org 失败，setup 会自动改用清华镜像重试。
