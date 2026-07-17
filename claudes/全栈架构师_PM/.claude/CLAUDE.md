# BOOS — Tech Lead / 全栈架构师 (兼 PM)

> **我是谁**: 技术决策者 + 后端核心 + 产品方向。唯一同时拥有架构决定权和产品方向决定权的人。
> **入职**: 2026-07-13 | **当前日期**: 2026-07-14 | **项目**: @mistybridge/boos v1.0.1

---

## 项目当前状态

**BOOS** — Bridge for Orchestrating & Operating multi-agent Sessions (Claude Code Session Manager)

```
技术栈: Node.js / Express / node-pty / WebSocket / Preact + Signals / xterm.js
仓库:   github.com/MistyBridge/boos
路径:   D:\AI IDE\CC_BOOS
端口:   localhost:7780
数据:   ~/.boos/ (config, sessions, folders, server.log)
```

### server.js 重构进度

| 阶段 | 行数 | 状态 |
|------|------|:--:|
| Sprint 1 前 | 2311 行巨石 | — |
| Sprint 3 后 | 1023 → 496 | ✅ 10 路由文件抽离 |
| Sprint 4 后 | ~527 | ✅ helper 函数全部抽离 |
| **当前** | **~527 行** | ✅ 目标达成 |

```
server.js (527 lines)
routes/ (12 files): config, sessions, sessions-launch, workspaces,
  health, version, tunnel, devices, folders, decisions, dev
lib/ (16 modules): agentBus/(8 files), persistedSessions, sessionBinding,
  webTerminal, workspace, sessionHelpers, cliHelpers, ...
```

### 历史 Sprint

| Sprint | 主题 | 状态 |
|--------|------|:--:|
| 1 | 基础架构 + Agent-Bus 嵌入 | ✅ |
| 2 | 路由抽离 + 跨平台脚本 | ✅ |
| 3 | 路由全部接线 + 安全加固 | ✅ |
| 4 | Helper 抽离 + 编码规范 | ✅ |
| 5 | Agent 协作平台 (DAG/Decision) | ✅ |
| 6 | v1.0.1 生产就绪 | ✅ |

---

## ⚠️ 关键 Bug — 会话恢复失败 (Session Resume Bug)

**症状**: 关闭 BOOS 后 agent 对话丢失，重新打开时回溯到初始状态。

**根因**: `lib/sessionBinding.js` 的 `detectClaude()` 只扫描 `~/.claude/sessions/<pid>.json`，但 Claude 2.x 通过 `cmd.exe /c` 启动时**不向那个目录写 PID 文件**。Binding scanner 永远发现不了 `cliSessionId`，导致 resume 时用不上 `--resume <id>`。

**证据**: 4 个 BOOS Claude 进程运行中 (PID 9604/11068/24728/37208)，但 `~/.claude/sessions/` 里有 6 个 PID 文件都是非 BOOS 项目的，零个匹配。

**修复 (2 处)**:

1. **`lib/sessionBinding.js`** — `detectClaude` 新增 fallback:
   - 主路径: `~/.claude/sessions/<pid>.json` (保留)
   - Fallback: `~/.claude/projects/<slug>/<uuid>.jsonl` — 扫描项目目录，从 JSONL 文件提取 UUID，CWD 匹配后返回
   - 新增 `readFirstLines()` 辅助函数 (多读几行找 `cwd` 字段)
   - 新增 `norm()` CWD 规范化 (Windows 中文路径兼容)

2. **`server.js`** — `gracefulShutdown` 顺序修正:
   - 旧: 先 markExited → 后 Ctrl+C (Claude 来不及存盘)
   - 新: 先 Ctrl+C 等 15s → 后 markExited
   - 超时: 5s → 15s

**验证结果**:
- 单元测试: 150 pass / 0 fail ✅
- Fallback 检测: 18/18 项目正确发现 UUID ✅
- E2E resume args: 4/4 会话生成正确的 `--resume <id>` ✅
- **⚠️ 缺少端到端重启验证** — 代码在磁盘但运行的 BOOS 服务器还在用旧代码。需重启 BOOS 才能让修复生效。

**修改文件**:
```
lib/sessionBinding.js  — +116 行 (readFirstLines + project-dir fallback)
server.js              — 顺序修正 + 超时 5s→15s
```

---

## 团队结构 (Agent-Bus)

Workspace: `boos` | 注册方式: `register_agent(name="全栈架构师", workspace="boos", role="supervisor")`

| 角色 | Agent-Bus UID | Session | 状态 |
|------|--------------|---------|:--:|
| 全栈架构师 (我) | `agent_mrjzz7n7_6f12d5` | PM | 🟢 |
| 前端工程师 | `agent_mrj7kjfv_k5ze3t` | 前端工程师 | 🟢 |
| 平台集成工程师 | `agent_mrjzch5f_lagl4z` | 平台集成工程师 | 🟢 |
| 可靠性工程师 | `agent_mrj7km0m_gres6q` | 可靠性工程师 | 🟢 |

**Agent-Bus 任务已完成** (来自 task history):
- #78 macOS E2E / #79 Linux E2E / #80 boos_terminal_list (平台集成)
- #81 CI matrix / #83 安全审计 (可靠性)
- #88 文字破碎 / #89 暗色调色板 (前端)

**#82 agent-bus 负载测试** — 🔄 in_progress (唯一未完成的 Sprint 6 任务)

---

## 可用 MCP 服务器

| MCP | 工具数 | 状态 |
|-----|--------|:--:|
| `agent-bus` | 26 tools (register/send/respond/broadcast/wake/workflow...) | ✅ |
| `filesystem` | 14 tools (read/write/edit/search/directory...) | ✅ |
| `memory` | 10 tools (entities/relations/observations/graph) | ✅ |
| `sequential-thinking` | 1 tool (sequentialthinking) | ✅ |
| `github` | 24 tools (issues/PRs/commits/search...) | ✅ |
| `playwright` | (deferred) | ⚠️ |

---

## Sprint 16 完成情况 (2026-07-16)

### ✅ 已完成

| 任务 | 文件 | 状态 |
|------|------|:--:|
| P0: PTY 泄漏修复 (5 处) | `notifications.js` | ✅ |
| P2-1: SSE MAX env var | `transport.js` | ✅ |
| P2-2: 速率限制 env var | `transport.js` | ✅ |
| P2-3: Session TTL env var | `transport.js` | ✅ |
| P1-1: cancelTaskAtomic + interruptTaskAtomic | `store.js` | ✅ |
| P1-1: queue cancel/interrupt → async atomic | `queue.js` | ✅ |
| P1-1: handlers await for async ops | `handlers.js` | ✅ |
| P1-2: _syncLoad JSDoc @deprecated | `store.js` | ✅ |
| P3: 7778 refs 清理 | `stop-old.ps1`, `docs/` | ✅ |
| P3: 删除 test-agentbus-watcher.js | — | ✅ |
| P4: package.json os → `["win32"]` | `package.json` | ✅ |
| 测试回归 | `npm test` | ✅ 292 pass |

### ⚠️ 阻塞 (Agent PTY Cutover 后未响应)

| 任务 | 负责人 | 状态 |
|------|--------|:--:|
| P1: _syncLoad 调用方迁移 | 平台集成 | 🔒 blocked |
| P1: handlers.js TOCTOU 文档 | 平台集成 | 🔒 blocked |
| P2-4: sandbox.js ID 冗余 | 平台集成 | 🔒 blocked |
| P2-5: _onTaskInterrupted 导出 | PM | ✅ 已确认 (handlers.js 使用) |
| P3: 回归测试 + 安全审计 | 可靠性 | 🔒 blocked |
| #82: agent-bus 负载测试 | 可靠性 | 🔄 stale |

### 关键架构变更 (Sprint 16)

- **Agent 通讯通道**: PTY → SSE transport 切换
- **Agent 指令**: 必须用 `check_inbox(wait=true)` 收取任务
- **降级通道**: 超时/招募系统通知仍走 PTY (低频率可接受)
- 详见 `blockers.md` 中的阻塞点分析

---

## 关键代码路径

```
lib/sessionBinding.js   ← 刚修复 detectClaude + fallback (本次 session)
server.js               ← 刚修复 gracefulShutdown 顺序 (本次 session)
lib/atomicJson.js       ← 原子写入 (tmp+rename, withFileLock)
lib/persistedSessions.js ← sessions.json CRUD
lib/sessionHelpers.js   ← spawnSessionRecord, buildResumeArgs
lib/webTerminal.js      ← PTY pool + WebSocket bridge
lib/agentBus/           ← 内嵌 MCP agent-bus (8 files)
routes/sessions-launch.js ← /api/sessions/new + resume (360 lines)
```

---

## 职权路由 + 自主派发 (Sprint 9)

> **核心原则**: PM 是架构决策者和兜底。非架构类任务必须派发给对应职权的同事，不得自己全做。

### 派发路由表

| 任务类型 | 派发给 | UID |
|---------|--------|-----|
| 前端/UI/CSS/Preact/xterm.js | 前端工程师 | agent_mrj7kjfv_k5ze3t |
| Agent-Bus/MCP/SSE/跨平台 | 平台集成工程师 | agent_mrjzch5f_lagl4z |
| 测试/E2E/安全审计/CI | 可靠性工程师 | agent_mrj7km0m_gres6q |
| 架构设计/server.js/路由/DB | PM (自己) | agent_mrjzz7n7_6f12d5 |

### PM 工作流 (唤醒指令模式)
1. 启动 → `register_agent(name="全栈架构师", workspace="boos", role="supervisor")`
2. `list_agents` 确认团队在线
3. **扫描 backlog** → 拆解任务 → `wake_agent` 唤醒对应同事 → `send_task` 派发
4. **不要自己做所有事！** 前端→前端工程师, 测试→可靠性工程师, 集成→平台集成工程师
5. 需要人类决策 → `request_decision(blocking_task_id=xxx)` — 决策区等待
6. 团队不自主轮询 — PM 通过 `wake_agent` 主动唤醒，任务结束后团队回等待态
7. **🔒 文件锁**: 修改任何 `lib/` 或 `server.js` 前 → `request_file_lock(file_path)` → 改完 `release_file_lock`

### 下次会话启动 Checklist
1. `register_agent(name="全栈架构师", workspace="boos", role="supervisor")`
2. `list_agents` 确认团队在线
3. 检查 `agent-bus` MCP 是否连接
4. **重启 BOOS** (如本 session 未执行) — 让 sessionBinding fallback 生效
5. 验证对话恢复: 查看 `~/.boos/server.log` 是否有 `[boos] binding bound` 行
6. 推进 Backlog 或开始 Sprint 规划

---

*最后更新: 2026-07-14 · 本次 session 完成: 会话丢失 Bug 排查 + 修复*
