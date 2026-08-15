# 小未来

「小未来」是一个轻量的 Electron 桌面 Live2D 桌宠。它保留透明悬浮角色、点击互动、人格设置和本地大模型聊天，去除了记忆库、日程、主动打扰、工具和托盘等扩展功能。

## 当前功能

- 纯 Live2D Canvas 角色渲染，使用 Cubism 模型命中检测处理点击、拖拽和右键。
- 透明无边框桌宠窗口，可调整角色大小、是否始终置顶和角色轮廓阴影。
- 单击角色生成一条独立互动回复；双击角色打开聊天输入框。
- 轻量输入框支持回车发送、`Shift+Enter` 换行和流式回复。
- 语音输入（可选）：点击 `🎤` 开启后，对桌宠说话即可识别，说话文字实时填入输入框并由你确认/自动发送。
- 语音输出（可选）：小未来的回复会用本地 `edge-tts` 合成并朗读，播放时角色有说话动画；你开口时会打断正在播放的语音。
- 轻量输入框默认覆盖在角色腹部中央，回复气泡居中显示在角色头顶。
- 展开聊天记录后显示用户与小未来的全部历史消息，支持滚动和关闭。
- 聊天历史保存在 Electron `userData/chat-history.json`，互动回复也会记录，但不会进入正式多轮上下文。
- Provider 面板支持 OpenAI 兼容的 Ollama、vLLM、LM Studio 等服务，并按配置顺序自动回退。
- 人格面板支持编辑运行时人格覆盖。

展开聊天记录时聊天窗口会变成普通窗口、可被其他应用覆盖；但角色始终置顶（floating），不会因展开对话框而消失。收起后轻量输入框恢复置顶。

## 快速开始

### 环境

- Node.js 20 或更高版本
- npm
- 一个可用的 OpenAI 兼容 `/v1` LLM 服务
- Electron 43.3.0（由项目依赖安装）
- 语音（可选）：Python 3.10 + `warashi` 项目的 venv（详见下文「语音输入与语音输出」）

### 安装与启动

```bash
npm install
npm start
```

开发调试：

```bash
npm run dev
```

`npm run dev` 会打开 DevTools，并把渲染进程 console 输出到终端。

## 使用方式

| 操作 | 效果 |
| --- | --- |
| 单击角色轮廓 | 生成一条点击互动回复 |
| 双击角色轮廓 | 打开轻量聊天输入框 |
| 拖拽角色轮廓 | 移动桌宠窗口 |
| 右键角色轮廓 | 打开菜单 |
| 输入框顶部展开按钮 | 展开或收起聊天记录 |
| 输入框右上角 `×` | 关闭输入框 |
| 点击 `🎤`（宠物窗左下角或输入框左侧） | 开启/关闭语音输入；加载中呈橙色脉冲，就绪后呈绿色脉冲 |

只有 Live2D 模型的实际命中区域可互动，透明背景不会触发操作。

## 配置

### TiMem 长期记忆（可选）

Mirai 支持通过 TiMem 云服务为正式聊天增加长期记忆检索。默认关闭；启用后，聊天请求会先检索最多 5 条相关记忆注入 Prompt，回复完成后异步提交本轮对话供 TiMem 提炼。TiMem 请求失败不会阻塞本地模型对话。

将 `.env.example` 复制为 `.env`，仅在本机填写以下配置：

```dotenv
TIMEM_ENABLED=true
TIMEM_BASE_URL=https://api.timem.cloud
TIMEM_API_KEY=你的TiMem密钥
TIMEM_USER_ID=mirai-owner
TIMEM_CHARACTER_ID=mirai
TIMEM_SESSION_ID=desktop-session
```

也可以使用 `TIMEM_USERNAME` 和 `TIMEM_PASSWORD`，由 Mirai 调用 TiMem 登录接口获取短期令牌。`.env` 已被 Git 忽略，密钥不会进入仓库。TiMem 记忆数据属于第三方云服务；需要完全离线时保持 `TIMEM_ENABLED=false`。

### 语音输入与语音输出（可选）

语音识别（输入）和语音朗读（输出）通过一个独立的 Python 侧车进程实现，复用 [Open-LLM-VTuber](https://github.com/r3mur4/Open-LLM-VTuber)（warashi）的 VAD/Silero 与 ASR/Sherpa-ONNX，输出用 `edge-tts` 合成。侧车通过本机 WebSocket 通信，PCM/音频只走 `127.0.0.1`，不经任何云端。

前置（仅当使用语音时）：

- 已安装 warashi 项目的 venv（Python 3.10），并补装依赖：`silero-vad`、`edge-tts`、`sherpa-onnx`、`numpy`、`websockets`。
- ASR 模型已就位：`warashi/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/{model.int8.onnx,tokens.txt}`。

开启方式：点击宠物窗左下角或输入框左侧的 `🎤`。侧车在 `npm start` 启动时即后台预热（加载约 1GB 的 SenseVoice 模型，首次需约 20–50 秒），就绪后识别瞬时；就绪前 `🎤` 呈橙色脉冲。语音识别文字会实时填入输入框并自动发送（在 `src/renderer/chat-input.js` 中可用 `AUTO_SEND_VOICE` 关闭自动发送，改为只填输入框由你确认）。

可用的环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MIRAI_WARASHI_ROOT` | `/Users/urahyou/Desktop/warashi` | warashi 项目根目录 |
| `MIRAI_SIDECAR_PORT` | `8765` | 侧车 WebSocket 端口 |
| `MIRAI_SIDECAR_PYTHON` | `<warashi>/.venv/bin/python3` | 侧车 Python 解释器 |
| `SIDECAR_ASR_LANGUAGE` | `zh` | 识别语言（简体中文） |
| `SIDECAR_TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | `edge-tts` 音色 |

若语音不可用，聊天仍完全正常（文字输入/输出不受影响）。

### Provider

`src/core/llm-providers.json` 只提供不含密钥的出厂模板。右键菜单中的 Provider 面板会把实际配置写入 Electron `userData/llm-providers.runtime.json`，不会改写或上传仓库文件。API Key 只从项目根目录的 `.env` 读取。

- `activeProvider`：优先使用的 Provider。
- `providers`：OpenAI 兼容服务配置。
- Provider 对象的键顺序决定自动回退顺序，当前激活项会排在第一位。
- 每个 Provider 的 `apiKeyEnv` 指向 `.env` 中的变量名；变量为空时不会发送 Authorization 请求头。

不要把模型地址或密钥硬编码到 `src/main/main.js`。

### 人格与本地数据

- 出厂人格：`src/core/personality.json`
- 用户人格覆盖：Electron `userData/personality-runtime.json`
- 显示设置：Electron `userData/display-settings.json`
- 聊天记录：Electron `userData/chat-history.json`
- Provider 运行时配置：Electron `userData/llm-providers.runtime.json`

复制 `.env.example` 为 `.env` 后填写密钥。`.env` 已被 Git 忽略，绝不应提交。

macOS 默认 userData 目录通常是：

```text
~/Library/Application Support/haruhana-quest/
```

## 项目结构

```text
assets/live2d/             Cubism Core、模型、动作和模型纹理
src/main/main.js           主进程、窗口管理、IPC、聊天调度
src/main/preload.js        contextBridge 安全桥接
src/main/ipc-validation.js IPC 入参校验
src/main/voice-bridge.js   语音侧车守护与 WebSocket 桥（输入 PCM + 输出 TTS 音频）
voice-sidecar/             语音侧车（Python，复用 warashi VAD/ASR + edge-tts）
src/renderer/renderer.js   Live2D 角色、命中检测、气泡、互动、麦克风采集与语音播放
src/renderer/live2d-avatar.js Live2D 模型封装
src/renderer/chat-input.* 轻量输入框和展开聊天记录
src/engine/generic.js      OpenAI 兼容 LLM 调用和进程内多轮上下文
src/services/              人格、显示设置和聊天历史服务
src/core/                  出厂人格和 Provider 配置
test/                      Node.js 自动化测试
```

## 验证

```bash
npm run check
```

该命令执行 JavaScript 语法检查和全部 `node:test` 测试。项目没有单独的 lint 或 typecheck 脚本。

## Live2D 许可

当前仓库包含 Live2D Cubism Core 和 Hiyori Free 示例模型。模型原始许可、作者和使用条件见 [assets/live2d/README.md](assets/live2d/README.md) 及模型目录中的 `ReadMe.txt`。

## 许可

项目代码使用 MIT 许可。Live2D 模型和运行时遵循其各自的官方许可。
