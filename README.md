# wechat-claude-skill

让 Claude Code 同时在终端和微信中与你对话。

通过 Claude Code 的 Skill + Hook 机制，实现微信消息的双向桥接——你在微信发的消息会自动注入 Claude Code，Claude 的回复也会自动推送回微信。

灵感来自 [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)。

## 功能

- 🔄 **双向通信**：微信 ↔ Claude Code 实时互通
- 💻 **CLI 模式**：新终端窗口运行 Claude Code，终端和微信都能输入
- 📺 **VSCode 模式**：在 VSCode 中使用 Claude Code，回复自动推送微信
- 🔐 **QR 扫码登录**：终端展示二维码 + 自动打开浏览器，1 秒轮询
- 🛡️ **消息去重 & 限流**：内置 iLink API 限流退避和会话过期重试
- 📦 **一键安装**：`npm install -g` + `/wechat` 即可使用

## 安装

### 前置要求

- Node.js >= 18
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
- 微信账号（用于扫描 QR 码绑定 Bot）

### 全局安装

```bash
npm install -g wechat-claude-skill
```

### 初始化

```bash
wechat-claude-skill install
```

这会完成：

1. 将 Skill 和 Hook 写入 `~/.claude/` 全局配置
2. 安装 `/wechat` 和 `/unwechat` 两个 Slash 命令

> 扫码登录在执行 `/wechat` 时自动触发，无需提前操作。

## 使用

### CLI 模式（推荐）

1. 在终端中启动 Claude Code：
   ```bash
   claude
   ```

2. 输入 `/wechat`，选择「CLI 终端」

3. 自动打开新终端窗口，窗口标题为 `[微信桥接] Claude Code`
   - 旧窗口可以关闭
   - 新窗口中 Claude Code 继续之前的对话
   - 在新窗口中可以手动输入，也可以从微信发消息

4. 在微信中给 Bot 发一条消息激活（首次必须）

### VSCode 模式

1. 在 VSCode 的 Claude Code 中输入 `/wechat`，选择「VSCode」
2. 扫码绑定后在微信中发一条消息激活
3. 之后 Claude Code 的回复自动推送到微信（单向通知）

### 解绑

在 Claude Code 中输入 `/unwechat`，或运行：

```bash
wechat-claude-skill unbind
```

## 架构

项目有两种运行模式，根据使用场景选择：

### CLI 模式（双向通信）

```
┌─────────────┐         ┌──────────────────────────────┐
│   微信客户端  │◄───────►│        Bridge 进程            │
│             │  iLink  │  ┌────────────────────────┐  │
│  用户发消息   │  API    │  │  getUpdates 长轮询      │  │
│  收到回复     │         │  │  → 消息队列 Queue       │  │
│             │         │  └──────────┬─────────────┘  │
└─────────────┘         │             │                 │
                        │             ▼                 │
┌─────────────┐         │  ┌────────────────────────┐  │
│  新 CMD 窗口  │◄───────►│  │  PTYServer (node-pty)  │  │
│             │  stdin   │  │  → claude --continue    │  │
│  用户手动输入 │  stdout  │  │  → 注入微信消息(粘贴)   │  │
│  查看 Claude │         │  └────────────────────────┘  │
│  回复        │         │             │                 │
└─────────────┘         │             ▼                 │
                        │  ┌────────────────────────┐  │
                        │  │  Stop Hook (hook-handler)│  │
                        │  │  → sendMessage 推送微信   │  │
                        │  └────────────────────────┘  │
                        └──────────────────────────────┘
```

**数据流**：
1. 用户在微信发消息 → iLink `getUpdates` 长轮询收到 → 放入消息队列
2. PTYServer 检测到 Claude Code 空闲（`❯` 提示符）→ 用 bracketed paste 注入消息到 Claude Code
3. Claude Code 回复 → Stop Hook 触发 → hook-handler 调用 `sendMessage` 推送到微信

### VSCode 模式（单向通知）

```
┌─────────────┐         ┌──────────────────────────────┐
│   微信客户端  │◄────────│        Bridge 进程            │
│             │  iLink  │                              │
│  收到回复    │  API    │  getUpdates 长轮询（保活）     │
│             │         │  → 维持 Bot 在线状态           │
└─────────────┘         └──────────────────────────────┘
                                    ▲
                                    │ sendMessage
                        ┌───────────┴───────────┐
                        │  hook-handler (Stop)    │
                        │  读取 last_assistant_   │
                        │  message → 推送微信      │
                        └───────────┬───────────┘
                                    ▲
                        ┌───────────┴───────────┐
                        │  VSCode Claude Code     │
                        │  用户正常使用           │
                        └───────────────────────┘
```

**数据流**：
1. 用户在 VSCode 中正常使用 Claude Code
2. Claude 回复完成 → Stop Hook 触发 → hook-handler 发送 `sendMessage` 到微信
3. Bridge 仅负责 `getUpdates` 长轮询以维持 Bot 在线（iLink 要求先收到用户消息才能发送）

## 为什么用 node-pty 而不是 child_process.spawn？

这是本项目的核心技术决策。Claude Code 是一个交互式 TUI 程序（基于 Ink/React CLI），它：

1. **需要真实终端**：Claude Code 使用 alternate screen buffer、光标定位、颜色渲染等终端特性。`spawn` 创建的管道进程没有 TTY，Claude Code 无法正常渲染
2. **需要实时交互**：`spawn` 只能一次性传入 stdin，无法在 Claude Code 运行过程中动态注入新消息。而 `node-pty` 创建的伪终端支持随时 `write()`，实现消息的实时注入
3. **需要处理 bracketed paste**：Claude Code 启用了 `\x1b[?2004h`（bracketed paste mode），直接 `write(text + '\r')` 只会让文字出现在输入框但不会提交。必须用 `\x1b[200~...\x1b[201~` 包裹文本后再发送 Enter

简而言之：**spawn 无法让 Claude Code 正常运行，也无法让微信消息实时注入到正在运行的 Claude Code 会话中**。



## 项目结构

```
src/
├── auth.ts          # QR 扫码登录，获取 botToken
├── bridge.ts        # Bridge 主入口（HTTP 服务 + 轮询 + PTY）
├── config.ts        # 配置常量（端口、轮询间隔、路径）
├── hook-handler.ts  # Stop Hook 处理（Claude 回复 → 微信）
├── pty-server.ts    # PTY 服务器（node-pty + Claude Code）
├── queue.ts         # 消息队列（去重 + FIFO）
├── setup.ts         # 安装/卸载/CLI/VSCode 子命令
└── wechat.ts        # iLink Bot API 封装（发送/轮询/限流）
```

### 关键模块说明

| 模块 | 职责 |
|------|------|
| `pty-server.ts` | 用 node-pty 创建伪终端，启动 `claude --continue`，检测 `❯` 提示符判断就绪状态，通过 bracketed paste 注入微信消息 |
| `hook-handler.ts` | Claude Code Stop Hook 回调，读取 `last_assistant_message` 并调用 `sendMessage` 推送到微信 |
| `wechat.ts` | 封装 iLink Bot API：长轮询 `getUpdates`、限流发送 `sendMessage`、指数退避重试、会话过期检测 |
| `bridge.ts` | 组合以上模块：Express HTTP 服务 + 微信轮询 + PTY 管理 |
| `queue.ts` | 线程安全的 FIFO 队列，支持去重（msgId）和 `requeue`（未消费消息回队列） |
| `auth.ts` | QR 码登录流程：获取二维码 → 终端显示 + 自动打开浏览器 → 1 秒轮询扫码状态 |

## 已知问题 & 待改进

### 当前问题

| 问题 | 说明 |
|------|------|
| **旧窗口需手动关闭** | CLI 模式弹出新窗口后，旧窗口无法自动安全关闭（直接 kill 进程可能误杀其他 Claude Code 实例或丢失未保存的工作） |
| **Hook 是全局的** | Stop Hook 对所有 Claude Code 实例生效，多个实例同时运行时回复都会推送到微信，无法区分来源 |
| **单实例限制** | Bridge 监听固定端口 3456，同一时间只能运行一个 Bridge（CLI 或 VSCode） |
| **长消息截断** | 微信消息超过 4000 字符会被截断，图片/文件仅显示占位符 |
| **会话过期** | iLink Bot 会话长时间不活跃会过期（errcode=-14），需重新扫码 |

### 待改进方案

- **旧窗口自动关闭**：探索通过 Claude Code 的 IPC 机制发送 `/exit` 命令，或使用 Windows Terminal 的标签页 API
- **多实例支持**：引入 session_id 路由，每个 Bridge 实例使用不同端口，hook-handler 根据 session 分发
- **微信消息富媒体**：支持图片、文件等内容的双向传输
- **VSCode 模式双向化**：在 VSCode 中也能通过 Webview 接收和发送微信消息
- **Docker 支持**：容器化部署，避免本地环境依赖
- **配置面板**：Web UI 管理 Bridge 状态、绑定关系、消息历史

## 致谢

- [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) — 本项目的灵感来源，提供了 iLink Bot API 的实现思路
- [node-pty](https://github.com/microsoft/node-pty) — Microsoft 维护的跨平台伪终端库

## License

MIT
