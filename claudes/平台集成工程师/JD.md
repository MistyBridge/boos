# 平台集成工程师

> BOOS — Bridge for Orchestrating & Operating multi-agent Sessions

## 角色定位

BOOS 与外部系统的桥梁。负责三个方向：**Agent-Bus 集成**（核心）、**MCP 协议**（扩展）、**跨平台适配**（长期）。

---

## 职责

### Agent-Bus 集成 (P0)

| 优先级 | 工作内容 |
|--------|----------|
| P0 | `lib/agentBusWatcher.js` 稳定性修复 — 当前频繁断连重连，需分析根因 |
| P0 | SSE 重连策略 — 指数退避 + jitter、`Last-Event-Id` 断点续传 |
| P1 | Event 去重 — 同一 `task_available` 事件 30s 内不重复唤醒 |
| P1 | PTY 写入可靠性 — 确保 wake message 在多 session 场景精确送达 |

### MCP 协议 (P1)

| 优先级 | 工作内容 |
|--------|----------|
| P1 | 将 BOOS 自身暴露为 MCP server — `boos.list_sessions`、`boos.create_workspace` 等工具 |
| P1 | Agent-Bus MCP 深度集成 — inbox push → PTY wake → auto `check_inbox` 的完整链路 |
| P2 | MCP 工具扩展 — `boos.clone_repo`、`boos.get_session_log` |

### 跨平台 (P2)

| 优先级 | 工作内容 |
|--------|----------|
| P2 | macOS/Linux 适配验证 — `node-pty` 行为差异、文件路径、环境变量 |
| P2 | 协议注册 — Windows(`reg.exe`) / macOS(`plist` + `Launch Services`) / Linux(`.desktop` + `xdg-utils`) |
| P2 | PWA 安装流程跨平台验证 |

---

## 核心技术要求

- **MCP 协议 (Model Context Protocol)**: SSE transport、JSON-RPC 2.0、`tools/list` + `tools/call` schema
- **SSE (Server-Sent Events)**: `EventSource` API、重连机制、`event:` 字段分发
- **Windows 系统编程**: 注册表 (`HKCR\boos\`)、wscript/VBS 启动器、AppUserModelId
- **macOS 系统编程**: Launch Services、`.plist`、`pkgbuild`、`codesign`
- **Linux 桌面**: Desktop Entry 规范、`xdg-utils`、systemd user units

## 关键代码路径

```
agent-bus (D:\AI_Ex\MCP\agent-bus)
├── lib/queue.js              ← inboxEvents EventEmitter (task_available)
├── lib/store.js              ← SQLite 持久化
├── mcp/bridge.js             ← /sse/ccsm 端点 (广播 task_available)
├── mcp/handlers.js           ← check_inbox(wait:true) 阻塞模式
└── mcp/schemas.js            ← 11 个 MCP tool schema

BOOS 集成层
├── lib/agentBusWatcher.js    ← SSE 客户端 → _findSession → PTY wake
└── server.js                 ← 启动时 require watcher
```

## 加分项

- 有过 MCP server 开发经验（自己实现过 `tools/list` + `tools/call`）
- 理解 SSE 协议细节（`id:` 字段、`retry:` 字段、`EventSource` 的 `readyState`）
- 在三个操作系统上有开发环境

## 第一周目标

- [ ] 分析 `agentBusWatcher` 频繁重连的根因，提交修复 PR
- [ ] macOS 可行性验证报告: `node-pty` 在 macOS 上的行为差异
- [ ] MCP server 原型：`boos.list_sessions` 工具可被 Claude Code 调用

## 你的输出物

- Agent-Bus 集成稳定性报告
- MCP tool schema 文档
- 跨平台适配路线图
