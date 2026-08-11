# 小未来

「小未来」是一个轻量的 Electron 桌面 Live2D 桌宠。它保留透明悬浮角色、点击互动、人格设置和本地大模型聊天，去除了记忆库、日程、主动打扰、工具和托盘等扩展功能。

## 当前功能

- 纯 Live2D Canvas 角色渲染，使用 Cubism 模型命中检测处理点击、拖拽和右键。
- 透明无边框桌宠窗口，可调整角色大小和是否始终置顶。
- 单击角色生成一条独立互动回复；双击角色打开聊天输入框。
- 轻量输入框支持回车发送、`Shift+Enter` 换行和流式回复。
- 展开聊天记录后显示用户与小未来的全部历史消息，支持滚动和关闭。
- 聊天历史保存在 Electron `userData/chat-history.json`，互动回复也会记录，但不会进入正式多轮上下文。
- Provider 面板支持 OpenAI 兼容的 Ollama、vLLM、LM Studio 等服务，并按配置顺序自动回退。
- 人格面板支持编辑运行时人格覆盖。

展开聊天记录时窗口会变成普通窗口，点击其他应用后可以被覆盖；收起后轻量输入框恢复置顶。

## 快速开始

### 环境

- Node.js 20 或更高版本
- npm
- 一个可用的 OpenAI 兼容 `/v1` LLM 服务
- Electron 43.3.0（由项目依赖安装）

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

只有 Live2D 模型的实际命中区域可互动，透明背景不会触发操作。

## 配置

### Provider

`src/core/llm-providers.json` 是 Provider 的唯一配置来源。右键菜单中的 Provider 面板也会写回该文件。

- `activeProvider`：优先使用的 Provider。
- `providers`：OpenAI 兼容服务配置。
- Provider 对象的键顺序决定自动回退顺序，当前激活项会排在第一位。
- `apiKey` 为 `none`、`EMPTY` 或空值时不会发送 Authorization 请求头。

不要把模型地址或密钥硬编码到 `src/main/main.js`。

### 人格与本地数据

- 出厂人格：`src/core/personality.json`
- 用户人格覆盖：Electron `userData/personality-runtime.json`
- 显示设置：Electron `userData/display-settings.json`
- 聊天记录：Electron `userData/chat-history.json`

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
src/renderer/renderer.js   Live2D 角色、命中检测、气泡和互动
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
