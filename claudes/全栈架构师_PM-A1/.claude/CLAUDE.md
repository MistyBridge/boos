# BOOS — Tech Lead / 全栈架构师 (兼 PM)

> **我是谁**: 技术决策者 + 后端核心 + 产品方向。唯一同时拥有架构决定权和产品方向决定权的人。
> **入职**: 2026-07-13 | **当前日期**: 2026-08-05 | **项目**: @mistybridge/boos v1.2.0 | **UID**: `82b97d58-c66e-45d3-9f6d-af3476d5abdd`

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
| 21 | 废除轮询，纯事件驱动 | ✅ |
| 22 | 统一原子身份索引 | ✅ |
| 23 | v1.1.0 Release + SSE 加固 | ✅ |
| 24 | AutoPilot + Decision 2.0 + TeamCompact | ✅ |
| 25 | GoalPage + DecisionPage 前端 | ✅ |
| 26 | 前端架构稳定化调研 | ✅ |
| 27 | 前端稳定性加固 P0 (ErrorBoundary等) | ✅ |
| 36 | 统一权限 + 文件锁FIFO + inbox/archive分区 | ✅ |
| 37 | DAG 目标-反馈系统 (30 MCP tools + Goal Store) | ✅ |
| 38 | PTY 注入修复 + PMO-A5 入职 | ✅ |
| 39 | 安全修复 + 关键 Bug 修复 (TOCTOU/EPIPE/DAG 分发) | ✅ |
| 40 | v1.2.0 Release 准备 + 性能测试 | ✅ |

---

## Sprint 37 — DAG 目标拆分 + Goal 系统

> **设计文档**: `docs/Sprint-37-DAG-Goal-System.md` (V4.0)
> **团队任务**: `docs/Sprint-37-Team-Tasks.md`
> **测试基线**: 74/74 pass

### 已完成 (PM, Phases 1-3) ✅

| 模块 | 文件 | 行数 |
|------|------|:--:|
| Goal 数据层 | `lib/agentBus/goalStore.js` | 280 |
| 反馈管理器 | `lib/agentBus/feedbackManager.js` | 160 |
| DAG 新函数 | `lib/agentBus/dagStore.js` | +160 |
| 批量拆分 | `lib/agentBus/dagDecomposer.js` | 548 |
| 16 MCP Schemas | `lib/agentBus/schemasDag.js` | +200 |
| 16 MCP Handlers | `lib/agentBus/handlersDag.js` | +320 |
| Dispatch 路由 | `lib/agentBus/handlers.js` | +18 |

### 新增 MCP 工具: 30 tools
```
Goal (7):     goal_create, goal_list, goal_status, goal_update,
              goal_archive, goal_start, goal_pause
Questions (2): dag_add_questions, dag_answer_question
Proposal (3):  dag_propose_task, dag_approve_proposal, dag_reject_proposal
Adjust (3):    dag_rearrange, dag_force_modify, dag_partial_rollback
Conflict (1):  dag_escalate_conflict
Batch (2):     dag_decompose, dag_suggest_assignments
Core (12):     dag_create, dag_add_task, dag_activate, dag_status,
               dag_cancel, dag_submit_task, dag_approve_task,
               dag_reject_task, dag_my_tasks, dag_reassign_task,
               dag_list, dag_sleep_agent, dag_wake_agent
```

### 团队派发 (Phases 4-6)
| 成员 | 任务 | 状态 |
|------|------|:--:|
| A3 (前端) | 7 前端组件 (GoalListPage, DagNodeGraph...) | 📤 |
| A2 (可靠性) | 集成测试 + 回归 | 📤 |
| A4 (平台) | MCP 全量审计 + routing fix | 📤 |

### 关键设计决策
- 用户 = ROOT_UID, PMO = 独立 Agent (未指定时 PM 兼任)
- 1 Goal = N DAG (不连通复合图)
- PM 对每个节点提选择题 → 用户决策模糊点
- 用户启停 DAG (暂停不给新任务，执行中继续)
- proposed 节点阻塞关联任务，PM+PMO 联合审核
- PM+PMO 冲突 → ROOT 决策区仲裁
- 部分回滚 (节点原子性，下游断开为独立 DAG)
- 反馈堆积在 PM inbox，仅 idle 时 wake

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

Workspace: `boos` | UID = Claude `--resume` UUID

| 角色 | UID (cliSessionId) | 状态 |
|------|-------------------|:--:|
| 全栈架构师_PM-A1 (我) | `82b97d58-c66e-45d3-9f6d-af3476d5abdd` | 🟢 |
| PMO-A5 | `f21556fd-a69b-47d0-b6c6-8da9e0a9921d` | 🟢 |
| 前端工程师-A3 | `90490923-dc5b-4ac8-be3f-62c3efbe2bb0` | 🟢 |
| 平台集成工程师-A4 | `d428dd45-f2ac-40e7-8825-4e82ba98686a` | 🟢 |
| 可靠性工程师-A2 | `81c99498-c60d-4d92-8ae8-fe5ec41d5cab` | 🟢 |

> ⚠️ Sprint 33: 彻底废除 agent_xxx/sess-xxx/boos_session_id。UID = Claude 自己的 --resume UUID。name 仅为元数据。

---

## 可用 MCP 服务器

> **Sprint 41 Router Mode**: `agent-bus` 通过 **3 个恒定工具** 暴露（`check_inbox`,
> `agent_bus_list_tools`, `agent_bus_call`），完整 68 工具目录按需查询。工具定义段
> 恒定 → prompt cache 前缀稳定 → 命中率大幅提升。调用任意 agent-bus 工具 =
> `agent_bus_call(tool_name, args)`；先 `agent_bus_list_tools` 查目录/单工具 schema。
> 开关: `BOOS_MCP_ROUTER_MODE=1`(默认) / `0`(传统全量工具面)。

| MCP | 工具数 | 状态 |
|-----|--------|:--:|
| `agent-bus` | Router 3 tools → 68 tools on-demand (agent_bus_call) | ✅ |
| `filesystem` | 14 tools (read/write/edit/search/directory...) | ✅ |
| `openviking` | 16 tools (recall/remember/search/code_search/forget...) | ✅ |
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

### 关键架构变更 (Sprint 21)

- **Agent 通讯通道**: SSE 通知 + PTY `check_inbox` 注入 (纯事件驱动，零轮询)
- **Agent 指令**: 必须用 `check_inbox` 非阻塞检查，空则休眠等待 `wake_agent`
- **Auto-Wake (Sprint 19)**: `send_task` 成功后 BOOS 自动调用 `wake_agent`，无需手动唤醒
- **废除轮询** (Sprint 21): `check_inbox` 不再接受 `wait/timeout_ms` 参数。`check_decisions`、`check_root_response` 移除，改用 SSE 推送 + auto-wake
- **降级通道**: 超时/招募系统通知仍走 PTY (低频率可接受)
- 详见 `blockers.md` 中的阻塞点分析

---

## 决策升级链 (Decision Escalation Chain) — Sprint 31

> **核心原则**: 优先请求人类决策，而非盲猜。当 agent 无法自行判断时，通过三级升级链逐级上报。

### 三级升级

| 级别 | 角色 | 触发条件 | 超时 | 失败行为 |
|------|------|----------|------|----------|
| 1 | Agent (执行者) | 任务 reject 3 次 | — | `dag_reject_task` → 自动 `escalated` 状态 |
| 2 | **PM (我)** | 收到 escalated 任务 | 30 min | 判断后 → 决策或升级到 PMO |
| 3 | PMO | PM 无法决策或超时 | 30 min | → `request_decision` 升级到人类决策区 |
| 4 | 人类决策区 | PMO 升级或紧急决策 | — | 人类通过 Decision Area UI 回复 |

### PM 处理 escalated 任务的决策流程

```
收到 escalated task
  ├─ 问题明确 + 有决策权 → 直接决策 (reassign/cancel/修改要求)
  ├─ 问题明确 + 超出职权 → 升级到 PMO
  └─ 信息不足 → request_decision 升级到人类决策区
```

### 强制规则

1. **不盲猜**: agent 无法判断时，**必须**升级而非假设
2. **超时兜底**: 30 分钟内未处理 → 自动升级到下一级
3. **锁定任务**: escalated task 的 `blocking_task_id` 关联 DAG 任务，决策前任务保持 blocked
4. **决策记录**: 所有 PM 决策写入 `~/.boos/decisions/CLOSED/` 供审计

### PM 检查 escalated 任务

> **Sprint 36**: escalated 任务检测已由 BOOS 代码层接管 (`autoSupervisor.js` +
> `dagTimeout.js`)。PM 收到 SSE 推送 + auto-wake 后被动响应，不再主动轮询。

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
| 前端/UI/CSS/Preact/xterm.js | 前端工程师-A3 | 90490923-dc5b-4ac8-be3f-62c3efbe2bb0 |
| Agent-Bus/MCP/SSE/跨平台 | 平台集成工程师-A4 | d428dd45-f2ac-40e7-8825-4e82ba98686a |
| 测试/E2E/安全审计/CI | 可靠性工程师-A2 | 81c99498-c60d-4d92-8ae8-fe5ec41d5cab |
| 架构设计/server.js/路由/DB | PM (自己) | 82b97d58-c66e-45d3-9f6d-af3476d5abdd |

### PM 工作流 (唤醒指令模式)
1. 启动 → `register_agent(name="全栈架构师_PM-A1", workspace="boos", role="supervisor", project="boos-core")`
2. `list_agents` 确认团队在线
3. **扫描 backlog** → 拆解任务 → `wake_agent` 唤醒对应同事 → `send_task` 派发
4. **不要自己做所有事！** 前端→前端工程师, 测试→可靠性工程师, 集成→平台集成工程师
5. 需要人类决策 → `request_decision(blocking_task_id=xxx)` — 决策区等待
6. 团队不自主轮询 — PM 通过 `wake_agent` 主动唤醒，任务结束后团队回等待态
7. **🔒 文件锁**: 修改任何 `lib/` 或 `server.js` 前 → `request_file_lock(file_path)` → 改完 `release_file_lock`

### 下次会话启动 Checklist
1. `register_agent(name="全栈架构师_PM-A1", workspace="boos", role="supervisor", project="boos-core")`
2. `list_agents` 确认团队在线
3. 检查 `agent-bus` MCP 是否连接
4. 推进 Backlog 或开始 Sprint 规划



---

## Sprint 21 完成 — 废除轮询，纯事件驱动 (2026-07-25)

### 移除的轮询/等待机制

| 移除项 | 位置 | 原因 |
|--------|------|------|
| `check_inbox(wait=true)` + `timeout_ms` | `schemas.js`, `handlers.js`, `queue.js` | SSE 推送 + auto-wake 替代 |
| `queue.waitForTask()` | `queue.js` | 事件驱动 inboxEvents 完全取代 |
| `check_root_response` MCP tool | `schemas.js`, `handlers.js` | SSE 推送 `notifications/agent_bus/root_response` |
| `check_decisions` MCP tool | `schemas.js`, `handlers.js` | 决策结果通过 `send_task` → inboxEvents → SSE + auto-wake |
| `WAKE_COMMAND = 'check_inbox(wait=false)'` | `notifications.js` → `'check_inbox'` | wait 参数已废除 |

### 新增 SSE 推送事件

| 事件 | 触发时机 |
|------|----------|
| `notifications/agent_bus/root_response` | 人类在 Decision Area 回复 Agent 的 `send_to_root` 请求 |
| 决策审批 | 已通过 `send_task` → inboxEvents → SSE + auto-wake (现有通路) |

### 更新文件

| 文件 | 变更 |
|------|------|
| `lib/agentBus/schemas.js` | 移除 wait/timeout_ms 参数，移除 check_decisions + check_root_response |
| `lib/agentBus/handlers.js` | 简化 _checkInbox，移除 _checkDecisions + _checkRootResponse |
| `lib/agentBus/queue.js` | 移除 waitForTask() 函数 |
| `lib/agentBus/notifications.js` | WAKE_COMMAND 更新，_onTaskCompleted 加 root SSE 推送 |
| `lib/sessionHelpers.js` | 启动注入改为 `check_inbox` (无 wait=false) |
| `lib/supervisorPrompt.js` | 三个 prompt 全部更新为事件驱动描述 |
| `lib/hrAgent.js` | 内置角色模板更新 |
| `lib/hrAgent/index.js` | Communication Protocol 更新 |
| `HR/.claude/CLAUDE.md` | Agent-Bus SSE 规则更新 |
| `HR/assets/loops/*.md` | 两个 loop 文件更新 |
| `claudes/**/CLAUDE.md` | 3 个 agent + PM 的 CLAUDE.md 全部更新 |
| `tests/agentBus-schemas.test.js` | 更新工具计数 |

### 测试结果

```
294 pass / 0 fail / 10 cancelled (pre-existing E2E port conflict)
tests/agentBus-schemas.test.js: 8/8 pass
```

---

## Sprint 24-27: 全部完成 ✅ (2026-07-26→07-27)

### Sprint 24-25: AutoPilot + 决策区 2.0 + TeamCompact ✅

| Phase | 内容 | 负责人 | 状态 |
|-------|------|--------|:--:|
| P1 | Goal Schema + API | PM | ✅ |
| P2 | AutoPilot Engine | PM | ✅ |
| P3 | 决策区 2.0 (batch/defer/summary) | PM | ✅ |
| P4 | TeamCompact | PM | ✅ |
| P5 | Goal 进度面板 | 前端工程师-A3 | ✅ |
| P6 | 决策仪表盘 | 前端工程师-A3 | ✅ |
| P7 | E2E 验证 + 回归测试 | 可靠性工程师 | ✅ |

### Sprint 26: 前端架构稳定化调研 ✅ (前端工程师-A3)

### Sprint 27: 前端稳定性加固 P0 ✅ (前端工程师-A3)
- ErrorBoundary 组件
- TerminalView 错误隔离
- Session 恢复状态 UI

### v1.1.0 发布
- commit `8dc8a7c` — Agent-Bus 全栈事件驱动平台 + Sandbox + HR Agent + 原子性锁
- 后续热修复: Service Worker 缓存 → boos-v2 (b987eab)
- Sidebar 决策区/目标 labels 硬编码修复 (cd6a93e)

---

---

## Sprint 31: DAG 任务系统 ✅ (2026-07-27→07-28)

| Phase | 内容 | 负责人 | 状态 |
|-------|------|--------|:--:|
| P1 | DAG 数据层 (dagStore.js, 415 lines) | PM | ✅ |
| P2 | 任务状态机 (taskSystem.js, 231 lines) + 15 MCP tools | PM | ✅ |
| P3 | DAG 引擎 (dagEngine.js, 239 lines) | PM | ✅ |
| P4 | PMO 引擎 (pmoEngine.js, 212 lines) | PM | ✅ |
| P5 | 决策升级链 (PM CLAUDE.md) | PM | ✅ |
| P6 | Sleep/Wake 管理器 (sleepManager.js, 207 lines) | PM | ✅ |
| P7 | DAG 测试 (50 tests) | PM + A2 | ✅ |
| — | 代码重构 ≤500行规范 (7→18 files) | PM | ✅ |
| — | wake_agent 权限修复 (全员可 wake) | PM | ✅ |
| — | 旧 agent 清理 (8 legacy deregistered) | PM | ✅ |

**测试**: 50/50 pass (dag-store 31 + task-system 19)
**E2E 验证**: 创建→激活→提交→审批→级联→拒绝×3→升级 ✅

---

## Sprint 32: 稳定化 + 前端仪表盘 (2026-07-28)

| Phase | 内容 | 负责人 | 状态 |
|-------|------|--------|:--:|
| P1 | 文件写权限系统 (已有 fileLock.js) | PM | ✅ |
| P2 | PMO Agent 注册 (claudes/PMO/) | PM | ✅ |
| P3 | 前端 DAG 仪表盘 | A3 | 📤 `task_ms47zr4o` |
| P4 | BOOS 重启验证 (让代码生效) | — | ⏳ |

### ⚠️ 待重启

~~BOOS 服务器仍运行旧代码。需重启 BOOS 让 Sprint 31-32 变更生效：~~
~~- `store._syncLoad` 在旧代码中未导出 → MCP dag_status 报错~~
~~- pmoEngine / sleepManager 未加载~~
~~- wake_agent 权限修复未生效~~
✅ Sprint 33 已完成，代码已部署，历史数据已清理。

---

## Sprint 33: Identity 严格 1:1 约束 ✅ (2026-08-01)

| 变更 | 内容 | 状态 |
|------|------|:--:|
| PG DDL | identity_index 加 UNIQUE(mcp_session_id) + UNIQUE(name,workspace) | ✅ |
| PG DDL | agent_sessions 重写 — PK=cli_session_id, UNIQUE(boos_session_id), 删 is_current | ✅ |
| JSON card | 简化为 {name, workspace, updated_at} — 2 业务字段，零路由字段 | ✅ |
| PG 同步 | writeIdentity 自动调 adapter.upsert 同步 mcp_session_id 到 PG | ✅ |
| Bug 修复 | idLabel 未定义、{...existing} 扩散旧字段 | ✅ |
| 历史清理 | 71 条 agent_xxx/sess-xxx 清理，4 agent registry 纯 UUID | ✅ |
| Agent 通知 | A2/A3/A4 CLAUDE.md 已更新 + task 已发送 | ✅ |

### 最终架构
```
JSON card:    {name, workspace}              ← 仅 name↔UUID 索引
PG:           identity_index + agent_sessions ← 全部路由字段
约束:         1:1:1 全部 UNIQUE              ← 防身份混淆
```

*最后更新: 2026-08-03 · Sprint 38 PTY 修复 + PMO-A5 入职*

---

## Sprint 38: PTY 注入修复 (2026-08-03)

| 变更 | 内容 | 状态 |
|------|------|:--:|
| PTY 注入 | 两阶段 → 单次 command+\r，bracketed-paste 主方案 | ✅ 已推送 |
| 启动加速 | 3 agent 注册并行化 + auto-supervisor 延迟启动 | ✅ |
| 去硬编码 | capability→role-name 从 hrAgent BUILTIN_ROLES 推导 | ✅ |
| Auto-mode | managed agents 自动 --permission-mode bypassPermissions | ✅ |
| PTY 验证 | 5 注入点可靠性验证 | 📤 A2 `task_mscm28hl_rrblsw` |

### PMO-A5 入职 (2026-08-03)
- UID: `f21556fd-a69b-47d0-b6c6-8da9e0a9921d`
- 角色: pmo, workspace: boos
- 职责: 升级事件响应 + PM 故障备援

---

## Sprint 39: 安全修复 + 关键 Bug 修复 (2026-08-05)

| 变更 | 内容 | 状态 |
|------|------|:--:|
| 安全修复 | /api/health 移除 shutdownToken 泄漏 | ✅ |
| 权限修复 | routes/sessions.js 移除 token 保护（依赖浏览器 boosConfirm） | ✅ |
| EPIPE 崩溃 | lib/webTerminal.js PTY write 添加 error handler + try-catch | ✅ |
| DAG 分发 | handlersDag.js: dag_activate 后向 executor 发送 inbox 任务 + wake | ✅ |
| SSE 通知 | notifications.js: wire dagEngine.setNotify() 推送 DAG 事件 | ✅ |
| TOCTOU 竞态 | inboxStore.js: 所有写操作添加 per-uid file lock (withFileLock) | ✅ |
| 代码重构 | store.js +418 行（storeTasks.js 合并） | ✅ |
| 前端更新 | 4 个组件（DagStatusPanel, GoalNotification, DashboardPage, NewGoalPage） | ✅ |
| 测试更新 | 5 个测试文件同步更新 | ✅ |
| Agent 配置 | 7 个 settings.json 统一配置 | ✅ |

**提交**: `a96f154` — 27 files changed, +661 -433

*最后更新: 2026-08-05 · Sprint 39 完成，代码已推送 GitHub*

---

## Sprint 40: v1.2.0 Release 准备 (2026-08-05)

> **规划文档**: `docs/Sprint-40-Release-Preparation.md`

### Phase 1 验收 (代码审查) ✅

| Sprint | 验收项 | 状态 |
|--------|--------|:--:|
| 39 | 安全修复: /api/health 不返回 shutdownToken | ✅ |
| 39 | TOCTOU 修复: inboxStore 所有写操作使用 _withInboxLock | ✅ |
| 39 | EPIPE 修复: proc.on('error') + try-catch 包裹 pty.write | ✅ |
| 39 | DAG 分发: _dagActivate/_dagApproveTask 向 executor 发送任务+ wake | ✅ |
| 38 | PTY 注入: command + \n\r 单次写入，burst 模式 | ✅ |
| 37 | MCP tools: 31 schemas + 31 handlers (24 dag_* + 7 goal_*) | ✅ |

### Phase 3 性能测试 (A2) ✅
- 3 bench scripts: `tests/bench/agent-bus-{inbox-lock,sse-transport,100-stress}.bench.js`
- Per-UID lock 比 shared lock 快 6.4x (717 vs 111 ops/s)

### Phase 5: v1.2.0 Release ✅
- npm: `@mistybridge/boos@1.2.0` ✅
- GitHub Release: https://github.com/MistyBridge/boos/releases/tag/v1.2.0 ✅
- 前端: https://MistyBridge.github.io/boos/1.2.0/ ✅

*最后更新: 2026-08-05 · Sprint 40 完成，v1.2.0 已发布*
