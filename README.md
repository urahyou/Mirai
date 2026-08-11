# 伪春菜复兴计划

一个类似 [伪春菜 / Ukagaka / 伺か](https://en.wikipedia.org/wiki/Ukagaka) 的 **Electron 桌面悬浮桌宠**「小未来」——透明、置顶、不占任务栏，聊天和点击回应由**本地或局域网大模型**现场生成。

## 功能

- 🖥️ **透明悬浮窗口**：无边框、置顶（screen-saver 层级）、不占任务栏，默认驻留右下角
- 🖱️ **拖拽移动**：抓住角色即可拖动，位置随意摆放
- 💬 **对话气泡**：点击打招呼、消息自动淡出、按内容切换表情（idle / happy / sad）
- 🗨️ **双击对话**：弹出可拖拽的输入框，回车发送、Esc 关闭，**流式逐字显示**回复
- **右键菜单**：聊天、Provider 设置、小未来的性格、退出
- 🖼️ **显示设置**：调整角色大小，并切换是否始终置顶
- 🎭 **人格可编辑**：出厂人格 `personality.json` + 运行时覆盖，人格面板保存后立即生效
- 🤖 **大模型驱动**：聊天和点击回应均由 LLM 生成（无本地预设台词）

## 快速开始

### 1. 环境要求

- [Node.js](https://nodejs.org/) ≥ 22（Electron 43 需要 Node ≥ 22）
- 一个可用的 OpenAI 兼容 LLM 服务（Ollama / vLLM / LM Studio 均可）

> **Node 版本说明**：项目使用 Electron 43，其安装工具 `@electron/get` 要求 Node ≥ 22。HOME brew 的 `node@20` 会下载不到 Electron 二进制，建议：
> ```bash
> brew install node@22 && brew link --overwrite --force node@22
> ```

### 2. 安装依赖

```bash
npm install
```

> **macOS 提示**：若旧版 Electron（如 31.x）公证被吊销，运行会 `SIGKILL` 或在「隐私与安全性」报"包含恶意软件"（实为误报）。当前 Electron 43.x 公证有效，如遇此报错请重装依赖获取完整体验的二进制，这不是代码问题。

### 3. 配置大模型（可选，默认可用 Ollama）

出厂的 `src/core/llm-providers.json` 已配置多个 Provider（见下文说明）。如需改用其它模型：

```bash
# 拉一个轻量中文模型
ollama pull qwen3:4b
# 或 vLLM 部署 DeepSeek，地址示例 http://192.168.99.99:8000/v1
```

在右键菜单 →「Provider 设置」里可以编辑地址、模型和参数，保存后写回到配置文件。

### 4. 启动

```bash
npm start
```

开发调试（打开 DevTools、打印渲染进程日志）：

```bash
npm run dev
```

## 使用说明

| 操作 | 效果 |
|------|------|
| 单击角色 | 大模型生成一句俏皮回应 |
| 双击角色 | 弹出对话输入框（回车发送，Esc 关闭，支持 Shift+Enter 换行） |
| 按住拖拽 | 移动角色位置 |
| 右键角色 | 打开菜单：聊天 / 显示设置 / 小未来的性格 / 模型设置 / 退出 |

## 配置说明（不要硬编码进代码）

- `src/core/llm-providers.json`：**LLM Provider 唯一配置来源**。`activeProvider` 决定当前用哪个，Provider 顺序即自动回退顺序。
  - Provider 支持本地/局域网 vLLM、Ollama、LM Studio（OpenAI 兼容 `/v1` 接口）。
  - `apiKey` 为 `none`/`EMPTY` 时不加 Authorization 头。
  - 改模型/地址/新增 Provider 都改这里（或面板保存），勿改 main.js。
- `src/core/personality.json`：角色**出厂人格**（只读默认）。`systemPrompt` 中的 `{personality}` 会被替换成整个 personality 对象注入给大模型。
  - 用户在「小未来的性格」面板编辑的内容存 userData `personality-runtime.json`，深合并到出厂之上。
> 用户的人格覆盖和显示设置存放在 Electron `userData` 目录：`~/Library/Application Support/haruhana-quest/`。

## 项目结构

```
.
├── AGENTS.md                 开发代理注意事项（改代码前必读）
├── package.json              入口、脚本（start / dev / check）
├── assets/character/         角色表情 idle.png / happy.png / sad.png（1254×1254）
├── src/
│   ├── main/
│   │   ├── main.js           主进程：窗口、IPC、对话调度和 Provider 管理
│   │   ├── preload.js        安全桥接（contextBridge → desktopPet.* 白名单）
│   │   └── ipc-validation.js 所有 IPC 入参校验（统一错误结构）
│   ├── renderer/             角色 UI、气泡、拖拽、右键菜单、各设置面板
│   ├── engine/
│   │   ├── generic.js        OpenAI 兼容 LLM 调用器（聊天/点击回应/流式）
│   │   ├── rules.js          仅负责读取合并后的人格配置（loadConfig/resetConfig）
│   ├── services/             人格运行时覆盖
│   └── core/                 personality.json / llm-providers.json
└── test/                     自动化测试（npm run check 执行）
```

## 开发与验证

```bash
npm run check   # 语法检查 + 运行全部自动化测试
npm start       # 启动
npm run dev     # 开发模式（DevTools + 渲染日志）
```

无 lint / typecheck，验证方式 = `npm run check` 通过 + 启动后观察 `/tmp/pet_*.log` 无应用层报错。

## 待办 / 未来方向

- [ ] 更多表情与动画（excited / tired / love / working、任务执行动画）
- [ ] Agent 工具系统与审批流（只读体检 → 授权写操作 → 代码 Agent）
- [ ] 安全扫描与隔离区
- [ ] 打包分发（.dmg / .exe）、开机启动、自动更新
- [ ] 更多人格 / 皮肤包体系（类似 shiori 的可换人格）

> 完整产品蓝图见 `小未来桌面管家-SPEC.md`。

## 许可

MIT
