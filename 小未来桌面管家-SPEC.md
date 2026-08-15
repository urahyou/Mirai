# 小未来产品规格（当前版本）

版本：0.1

本文是当前仓库的产品规格。旧版“桌面管家”蓝图中的长期记忆、日程、主动搭话、系统观察和 Agent 工具均已移出当前产品范围。

## 1. 产品定位

小未来是一个本地优先的 Electron Live2D 桌宠。它通过 OpenAI 兼容接口连接本地或局域网大模型，提供简短、连续、可回看的日常聊天。

## 2. 当前范围

### 2.1 角色

- 角色使用 Cubism Live2D 模型和 Canvas 渲染。
- 不再使用旧版 `assets/character/*.png` 作为角色或 fallback。
- 点击命中使用模型自身的 hit area 和几何轮廓。
- 角色窗口透明、无边框、不占任务栏，可拖动和调整大小。

### 2.2 互动

- 单击角色轮廓：生成一条独立点击回应。
- 双击角色轮廓：打开轻量聊天输入框。
- 右键角色轮廓：打开 HTML 菜单。
- 点击冷却和 turnId 防止多个回复互相覆盖。

### 2.3 正式聊天

- 输入框支持回车发送和 `Shift+Enter` 换行。
- LLM 使用 OpenAI 兼容 `/v1/models` 与 `/v1/chat/completions`。
- 支持 SSE 流式回复。
- Provider 按 `activeProvider` 和配置键顺序自动回退。
- 进程内保留最近 12 轮上下文。
- 聊天记录持久化到 `userData/chat-history.json`。
- 展开聊天框时展示用户和 assistant 的全部历史消息。
- 展开聊天框不是全局置顶，其他窗口可以覆盖它。

### 2.4 配置

- Provider 面板编辑服务地址、模型和采样参数。
- 人格面板编辑运行时人格覆盖。
- 显示面板调整角色大小、是否始终置顶和角色轮廓阴影。

### 2.5 语音（可选，默认本地）

- 语音输入：`🎤` 开启后对桌宠说话，识别文字实时填入输入框并可自动发送；文字输入/输出不受影响。
- 语音输出：小未来的回复用本地 `edge-tts` 合成并朗读，播放时角色有说话动画，开口可打断。
- 语音由独立 Python 侧车进程（复用 warashi VAD/ASR，输出 edge-tts）通过本机 WebSocket 提供，音频只在 `127.0.0.1` 传输。
- `🎤` 状态反映侧车加载进度（绿=就绪，橙=加载中）。

## 3. 非目标

当前版本不实现以下功能：

- 长期记忆库、记忆意图解析和记忆面板。
- 日程、提醒、安静时段和主动打扰。
- 情感状态持久化和好感度系统。
- Agent 工具、命令执行、文件操作和审批流。
- 托盘、云同步、账号体系和第三方上传。

## 4. 架构

```text
Electron main process
├── main.js                 窗口、IPC、Provider 回退、对话队列、语音调度
├── preload.js              desktopPet 安全桥接
├── ipc-validation.js       IPC 入参校验
└── voice-bridge.js         语音侧车守护与 WebSocket 桥（PCN 输入 + TTS 音频输出）

Renderer
├── renderer.js             Live2D、气泡、命中检测、点击互动
├── live2d-avatar.js        Pixi Live2D 封装
├── chat-input.js            输入框、流式记录、窗口拖动
├── menu.js                 右键菜单
└── *-panel.js              Provider、人格和显示设置面板

Core
├── generic.js              OpenAI 兼容调用器
├── rules.js                人格配置合并
└── llm-providers.json      Provider 唯一来源

Services
├── personality-runtime.js  用户人格覆盖
├── display-settings.js     角色显示设置
└── chat-history.js         持久化聊天记录

Voice sidecar（可选，独立进程）
└── voice-sidecar/sidecar_server.py   warashi VAD/ASR + edge-tts，WS 服务
```

## 5. 数据与隐私

所有用户人格、显示设置和聊天记录默认写入 Electron `userData`。模型请求只发送 system prompt、当前进程上下文和用户输入到用户配置的 Provider。项目不提供云端同步和自动上传功能。语音模式的 PCM 与合成的 MP3 只在 `127.0.0.1` 上与本地 Python 侧车交换，不经任何云端。

## 6. 验收标准

- `npm start` 能启动透明 Live2D 桌宠。
- Live2D 模型加载后，透明区域不能触发点击、拖动或右键菜单。
- 单击角色能显示点击回应，重复点击不会并发覆盖气泡。
- 双击角色能打开输入框并发送流式聊天。
- 展开聊天记录后，点击其他窗口可以覆盖它。
- 展开聊天记录后，角色仍保持置顶不消失。
- 重启应用后，聊天记录仍可显示。
- 开启 `🎤` 后能对桌宠说话识别；识别文字进入输入框；侧车未就绪时 `🎤` 呈橙色加载态。
- 语音关闭或侧车不可用时，文字聊天完全正常。
- `npm run check` 全部通过。

## 7. 后续候选项

后续如重新扩大产品范围，应单独设计并评审：Live2D 多动作状态、历史搜索、未读消息、皮肤包、打包分发和可控的长期记忆。不要直接恢复旧版已删除的服务模块。
