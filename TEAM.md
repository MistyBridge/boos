# BOOS 开发团队 · 岗位说明

> BOOS — Bridge for Orchestrating & Operating multi-agent Sessions
> 代码规模: 97 源文件 / ~24,000 行 (JS + CSS)
> 技术栈: Node.js / Express / node-pty / WebSocket / Preact / xterm.js / better-sqlite3

---

## 团队架构 (4人)

```
┌──────────────┐
│ Tech Lead    │  架构 + 后端核心
│ 全栈架构师    │  server, PTY, WebSocket, 持久化
└──────┬───────┘
       │
  ┌────┼────┬──────────┐
  │    │    │          │
  ▼    ▼    ▼          ▼
┌────┐┌────┐┌────────┐┌──────────┐
│前端 ││后端 ││平台集成 ││  QA/可靠性│
│工程师││工程师││工程师   ││  工程师   │
└────┘└────┘└────────┘└──────────┘
 UI/UX  持久化   Agent-Bus  测试/CI
 xterm   容错    MCP协议     压测/安全
 Canvas  会话    跨平台       自动化
```

---

## 岗位 1: Tech Lead / 全栈架构师

**定位**: 技术决策者 + 后端核心开发者，向 PM 汇报

### 职责

| 优先级 | 工作内容 |
|--------|----------|
| P0 | 制定整体架构方向，审核所有 PR |
| P0 | `server.js` 重构 — 将 1800 行巨石拆分为模块化路由 |
| P0 | 生命周期管理重写 — 关闭浏览器不应杀死服务 (解耦 `gracefulShutdown`) |
| P1 | `lib/atomicJson.js` 修复 — fsync + 备份恢复 + withFileLock 错误处理 |
| P1 | `lib/persistedSessions.js` 增强 — 会话快照/恢复，支持重启后 resume |
| P2 | 制定编码规范、分支策略、Release 流程 |
| P2 | 性能基准 — PTY 多路复用上限、内存占用、事件循环延迟 |

### 核心技术要求

- Node.js 深度理解：Event Loop、Stream 背压、libuv 层
- 进程管理：`node-pty`、`child_process`、信号处理、Windows Job Objects
- 文件系统：NTFS/ext4 原子写入语义、fsync/fdatasync、Journal 机制
- WebSocket 协议：RFC 6455，帧级别的 `ws` 库使用
- 架构模式：插件化、中间件链、事件驱动

### 加分

- 读过 CCSM/BOOS 现有代码，理解 `server.js` 和 `lib/` 的依赖关系
- 有 CLI 工具开发经验 (commander.js / yargs)
- 熟悉 Claude Code 的 `--resume`、`--continue` 机制

### 第一周目标

- [ ] 画出 BOOS 完整架构图 (ASCII doc)
- [ ] 提交 `atomicJson.js` fsync 修复 PR
- [ ] 给出 `server.js` 拆分方案 (route/ → 每个文件 ≤300 行)

---

## 岗位 2: 前端工程师

**定位**: 负责 BOOS 所有用户界面 — 桌面级 Web App，对标 claude.ai 交互体验

### 职责

| 优先级 | 工作内容 |
|--------|----------|
| P0 | Workspace 页面修复与增强 — Agent Canvas、Agent Node 拖拽/缩放完善 |
| P0 | xterm.js 集成优化 — 多 Tab 终端性能、resize 防抖、滚动性能 |
| P1 | Session 生命周期 UI — 启动/停止/恢复/删除的状态反馈和过渡动画 |
| P1 | 响应式布局完善 — 移动端 FAB、侧边栏抽屉、触摸拖拽 |
| P2 | 暗色主题完善 — CSS 变量体系、自动跟随系统 |
| P2 | PWA 安装体验 — manifest、service worker 缓存策略 |

### 核心技术要求

- Preact + Signals 深度理解：细粒度响应式、computed 派生、无 context 架构
- xterm.js：Addon 体系 (fit/webgl/unicode)、PTY-WebSocket 桥接
- CSS 体系化能力：Design Tokens、CSS Custom Properties、容器查询
- Pointer Events API：拖拽、resize handle、画布交互
- 浏览器 DevTools：Performance 面板、Memory 快照、Frame Rendering 分析

### 加分

- 有 Canvas/SVG 自由画布开发经验 (节点拖拽、缩放、平移)
- 熟悉 claude.ai 的 UI 语言 (Geist 字体、warm cream 色调)
- WebSocket 实时通信前端经验

### 第一周目标

- [ ] 修复 WorkspacePage 空状态崩溃 (已标记)
- [ ] Agent Node 拖拽边界限制 + 动画平滑
- [ ] 终端切换时减少闪烁 (DOM 复用 vs 重建)

---

## 岗位 3: 平台集成工程师

**定位**: BOOS 与外部系统的桥梁 — Agent-Bus、MCP 协议、跨平台适配

### 职责

| 优先级 | 工作内容 |
|--------|----------|
| P0 | `lib/agentBusWatcher.js` 稳定性 — SSE 重连策略、心跳、事件去重 |
| P0 | Agent-Bus MCP 深度集成 — inbox push → PTY wake → auto check_inbox |
| P1 | 跨平台适配 (macOS/Linux) — node-pty、协议注册、PWA 安装 |
| P1 | `ccsm://` / `boos://` 协议处理器 — Windows 注册表 / macOS plist / Linux desktop |
| P2 | Tunnel/远程访问 — Dev Tunnel 自动配置、SSH 隧道备选 |
| P2 | MCP 工具扩展 — 将 BOOS 自身暴露为 MCP server (管理会话、创建工作区) |

### 核心技术要求

- MCP 协议 (Model Context Protocol)：SSE transport、JSON-RPC 2.0、tool schema 定义
- SSE (Server-Sent Events)：EventSource API、重连、Last-Event-Id
- Windows 系统编程：注册表操作 (HKCR)、wscript/VBS 启动器、AppUserModelId
- macOS 系统编程：Launch Services、plist、pkgbuild
- Linux 桌面：Desktop Entry 规范、xdg-utils

### 加分

- 深度理解 agent-bus 架构 (queue.js EventEmitter、inboxEvents、waitForTask)
- 有过 MCP server 开发经验
- 了解 Claude Code 的 MCP 配置机制 (`.mcp.json` / `claude config`)

### 第一周目标

- [ ] 分析 `agentBusWatcher` 频繁重连原因，给出修复方案
- [ ] macOS 可行性验证：node-pty 在 macOS 上的行为差异
- [ ] MCP server 原型：`boos.list_sessions` 工具

---

## 岗位 4: QA / 可靠性工程师

**定位**: 保证 BOOS 在生产环境不丢数据、不崩溃、跨平台一致

### 职责

| 优先级 | 工作内容 |
|--------|----------|
| P0 | 测试体系搭建 — 从 0 到有 (当前 0 个测试文件) |
| P0 | `lib/atomicJson.js` 压力测试 — 模拟进程强杀、磁盘满、并发写入 |
| P0 | PTY 生命周期测试 — 创建/写入/resize/kill/zombie 清理 |
| P1 | E2E 测试 — Playwright 启动 BOOS → 创建会话 → 输入命令 → 验证输出 |
| P1 | CI/CD Pipeline — GitHub Actions: lint → unit → e2e → build |
| P2 | 安全审计 — WebSocket Origin 检查、CSRF、路径遍历 |
| P2 | 性能基准 — 10/20/50 并发 PTY 的内存增长曲线 |

### 核心技术要求

- 测试框架：Node.js 内置 `node:test` + `assert`，或 vitest/jest
- E2E: Playwright 或 Puppeteer，headless browser 操作
- 压力测试：chaos engineering 思维 (随机杀进程、填满磁盘、网络抖动)
- CI/CD: GitHub Actions workflow 编写
- 代码覆盖率：c8 / nyc 集成

### 加分

- 有数据损坏恢复的测试经验 (人为制造文件损坏验证恢复逻辑)
- 理解 NTFS 文件系统行为 (稀疏文件、Journal、USN)
- 有安全审计经验 (依赖漏洞扫描、注入测试)

### 第一周目标

- [ ] `atomicJson.test.js` — 覆盖正常写入、并发写入、模拟强杀恢复
- [ ] 编写 GitHub Actions workflow (lint + unit test)
- [ ] 设计 BOOS 质量门禁清单 (PR 合入前的检查项)

---

## 协作模式

```
Sprint: 1 周
站会: 每日 15min (异步文字)
代码审查: 至少 1 人 approve 后方可合入 main
PR 规范: feat/fix/chore 前缀 + 关联 issue + 变更说明

仓库: github.com/MistyBridge/boos
文档: D:\AI IDE\CC_Boos\docs\
Bug 跟踪: GitHub Issues
```

## 人员画像速查

| 岗位 | 一句话 | 核心技能 |
|------|--------|----------|
| Tech Lead | "把 1800 行的 server.js 拆成 10 个 150 行的模块" | Node.js 深度、架构设计 |
| 前端 | "让 CCSM 的管理页面比 claude.ai 还好用" | Preact Signals、xterm.js |
| 平台集成 | "让 BOOS 在 Win/Mac/Linux 上都能一键启动 agent" | MCP、SSE、系统编程 |
| QA | "从 0 个测试到 CI 全绿，数据零丢失" | 测试框架、Chaos Engineering |
