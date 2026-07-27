# Sprint 9: 全自动化闭环 — 计划文档

> 目标: 实现 agent 全自动协作，消除所有人工干预断点
> 日期: 2026-07-15 | 状态: ✅ 已完成 (7/7)

---

## 背景

Sprint 8 完成了基础 agent 通信平台（任务队列、通知投递、决策系统、优先级/重试/负载均衡）。但全自动化仍有 8 个缺口：

1. 任务无法"搁置等待人类决策"——只能完成或取消
2. 决策区只有 approve/reject 按钮，无可输入回复的内联栏
3. Agent 离线后无法被其他 agent 拉起
4. PTY 崩溃不自动恢复，过期任务无法重推
5. 测试中仍有 3 个 async 竞态失败
6. 运行中文件持续膨胀（agent-bus.json 从 116KB → 313KB 仅一个 sprint）
7. **PM 手动发令是阻塞点** — agent 被动等待 PM wake_agent 才工作，无自主轮询
8. **Agent 越权处理** — 接到非职权任务时硬做或失败，而非转发给对应同事

---

## 核心设计原则

> **职权路由**: Agent 遇到任务时，除非严格落于自身 capability 区间，否则必须 `send_task` 转发给对应职权的同事。不得越权处理。

| Agent | 职权区间 (capabilities) | 遇到以下任务时转发给 |
|-------|------------------------|-------------------|
| 前端工程师 | frontend, preact, xterm.js, css, UI | backend/architecture → PM |
| 平台集成工程师 | agent-bus, mcp, sse, cross-platform, integration | frontend/UI → 前端工程师 |
| 可靠性工程师 | testing, e2e, security-audit, debug, ci-cd | 需修改业务代码 → PM 或平台集成 |
| PM (全栈) | backend, nodejs, architecture, express, websocket | 纯前端 → 前端工程师; 纯测试 → 可靠性工程师 |

---

## 需求拆解

### R1: 任务 `blocked` 搁置状态

**现状**: 任务状态机 `pending → in_progress → completed/cancelled/interrupted/exhausted`

**目标**: 增加 `blocked` 状态。Agent 遇到需要人类决策的问题时：
- 调用 `request_decision(blocking_task_id)` → 任务状态变为 `blocked`
- Agent 继续处理 inbox 中其他任务
- 人类在决策区回答 → 决策系统发送 answer task (reply_to=decision_id)
- Agent 收到 answer → 恢复原任务 `blocked → in_progress` → 继续工作

**修改文件**:
- `lib/agentBus/queue.js` — 新增 `ST_BLOCKED`, `BLOCKABLE` 集合, `blockTask()`/`unblockTask()` 方法
- `lib/agentBus/store.js` — `updateTaskStatus` 支持 blocked 状态
- `lib/agentBus/handlers.js` — `_requestDecision` 接受 `blocking_task_id` 参数，自动 block
- `lib/agentBus/schemas.js` — `request_decision` schema 新增 `blocking_task_id`
- `routes/decisions.js` — `_notifyAgentOfDecision` 在发送 answer 后自动 unblock 原任务

### R2: 决策区内联回复

**现状**: DecisionsPage 只有 approve/reject 按钮，无文本输入

**目标**: 展开的 decision-card 底部出现输入栏 + 发送按钮。用户输入回复后：
- POST `/api/decisions/:id/reply` (新 endpoint)
- 系统发送 answer task 给提问 agent (复用 `_notifyAgentOfDecision`)
- 不跳转页面，回复后显示确认 toast

**修改文件**:
- `public/js/pages/DecisionsPage.js` — DecisionCard 新增 reply state + textarea + 发送按钮
- `public/js/api.js` — 新增 `replyDecision(decisionId, text)` 
- `routes/decisions.js` — 新增 `POST /api/decisions/:id/reply`
- `public/css/` — 新增 `.decision-reply` 相关样式

### R3: Agent 互拉 (Peer Launch)

**现状**: Agent session 只能通过 BOOS Web UI 手动启动，或 PM 在终端手动操作。Agent 离线 → 任务堆积。

**目标**: 任何 agent 可拉起任何其他 agent 的 session：
- 新增 MCP tool `launch_agent_session(agent_name, workspace)` — 无 supervisor 限制
- 内部调用 `lib/sessionHelpers.js` + `lib/webTerminal.js` 创建新 PTY session
- 如果 agent 的 BOOS session 已存在但 PTY 挂了 → resume
- 如果 agent 从未有过 session → 基于 `claudes/<role>/` 目录创建

**修改文件**:
- `lib/agentBus/schemas.js` — 新增 `launch_agent_session` tool 定义
- `lib/agentBus/handlers.js` — 新增 `_launchAgentSession` handler
- `lib/agentBus/notifications.js` — 离线检测 + 自动触发拉起
- `lib/sessionHelpers.js` — 暴露 `spawnSessionRecord` 供内部调用
- `routes/sessions-launch.js` — 提取 `_createSession` 核心函数

### R4: 容错 + 自恢复

**现状**: PTY 崩溃无自动恢复；任务超时只取消不重推

**目标**:
- **PTY 看门狗**: 每 30s 扫描 running session 的 `exitedAt`，发现意外退出 → 自动 resume
- **过期任务重推**: 超时任务 `cancelled` → `pending` (retry_count++) → 重新投递
- **发送失败重试**: `_onTaskAvailable` 中 PTY write 失败 → 记录失败次数 → 超过 3 次标记 agent 离线

**修改文件**:
- `lib/agentBus/notifications.js` — PTY watchdog + 发送失败跟踪
- `lib/agentBus/taskTimeout.js` — 超时任务改为可重推而非直接取消
- `lib/agentBus/queue.js` — `retryTask` 改为任意 agent (非仅 sender) 可重试 expired 任务

### R5: 测试修复 (#84)

**现状**: `sprint8-wave5-6.test.js` 中 3 个 async 测试失败

**目标**: 全部 13/13 pass
- 根因: `store.getPendingTask()` 使用 `_syncLoad()` 同步读盘，但 `insertTask` 用 `withFileLock` 异步写盘。测试中快速连续 sendTask→checkInbox 时，`_syncLoad` 读到旧快照。
- 修复: `getPendingTask` / `listPendingTasks` 改为异步版本（内部 `await _load()`）

**修改文件**:
- `lib/agentBus/store.js` — `getPendingTaskAsync` / `listPendingTasksAsync`
- `lib/agentBus/queue.js` — `checkInbox` 使用异步版本
- `tests/sprint8-wave5-6.test.js` — 修复后验证 13/13 pass

### R7: Agent 自主性 + 协作意愿增强

**现状**: Agent 被动等待 PM 发送 `wake_agent` 后才检查 inbox；接到越权任务时硬做或失败

**目标**:
- **自主轮询**: 每个 agent 启动后自动进入 `check_inbox(wait=true)` 长轮询循环，无需 PM 手动唤醒
- **职权路由**: 任务不在自身 capability 区间时，自动 `send_task` 转发给对应同事（附带说明原因）
- **空闲广播**: Agent 空闲超过 5 分钟 → broadcast 询问是否有待处理任务
- **心跳上报**: 每 60s 上报一次状态（idle/busy + 当前任务数）给 PM

**修改文件**:
- `claudes/前端工程师/.claude/CLAUDE.md` — 新增自主轮询 + 职权路由 + 转发规则
- `claudes/平台集成工程师/.claude/CLAUDE.md` — 同上
- `claudes/可靠性工程师/.claude/CLAUDE.md` — 同上
- `claudes/全栈架构师_PM/.claude/CLAUDE.md` — 同上 + PM 作为兜底
- `lib/agentBus/notifications.js` — 增强 idle 检测 → 自动提醒
- `lib/agentBus/schemas.js` — 可选: `report_status` tool

### R6: 文件归档 + 膨胀控制

**现状**: `~/.boos/agent-bus.json` 持续膨胀；`~/.boos/decisions/` .md 文件只增不减；无归档机制

**目标**:
- 新建 `~/.boos/archive/` 目录 — 30 天自过期
- 已完成/已取消/已 exhaust 的 task (超过 7 天) → 归档
- 已 decided 的 decision (超过 7 天) → 归档
- 归档文件可浏览、可恢复 (REST API)
- 定时清理: 每天检查 archive，删除超过 30 天的文件
- 测试 agent 自动清理: `after()` 中调用 `store.deleteAgent()`

**修改文件**:
- `lib/archive.js` (NEW) — 归档系统核心: `archive(type, id, data)`, `restore(type, id)`, `listArchive(type)`, `pruneExpired()`
- `lib/agentBus/store.js` — task CRUD 中触发归档检查
- `lib/decisionSystem.js` — decided 决策触发归档
- `routes/archive.js` (NEW) — REST API: list/restore/delete
- `server.js` — 启动时注册 archive 路由 + 定时 prune
- `tests/sprint8-wave5-6.test.js` — `_cleanup` 增加 `store.deleteAgent()`

---

## 任务分配

| # | 任务 | 负责人 | 优先级 | 估时 |
|---|------|--------|:--:|:--:|
| R1 | 任务 blocked 搁置状态 | PM (全栈) | P0 | 中 |
| R2 | 决策区内联回复 UI | 前端工程师 | P0 | 中 |
| R3 | Agent 互拉 (Peer Launch) | 平台集成工程师 | P1 | 大 |
| R4 | PTY 看门狗 + 容错自恢复 | 平台集成工程师 | P1 | 中 |
| R5 | #84 async 测试修复 | 可靠性工程师 | P1 | 小 |
| R6 | 文件归档 + 膨胀控制 | PM (全栈) | P2 | 中 |
| R7 | Agent 自主性 + 协作意愿增强 | PM (全栈) | P0 | 中 |
| — | 测试 agent 清理 (_cleanup) | 可靠性工程师 | P2 | 小 |

---

## 实施顺序

```
Wave 1 (并行): R1(PM) + R2(前端) + R5(可靠性) + R7(PM·各agent CLAUDE.md)
Wave 2 (并行): R3(平台) + R4(平台) + R6(PM)
Wave 3 (收尾): 全量回归测试 + E2E 验证
```

R1 和 R2 都涉及决策区 — PM 做后端 blocked 状态 + 新 API，前端做 UI 输入栏。R5 独立可并行。
R3 和 R4 都由平台集成工程师负责，内在关联（session 生命周期）。R6 独立。

---

## 验证计划

1. **R1+R2 联测**: Agent 发起决策 → 任务 block → 前端决策区显示 → 人类输入回复 → 发送 → Agent 收到 answer → 任务 unblock → 继续
2. **R3 测试**: 平台集成工程师 kill 前端工程师的 PTY → 等待 watchdog → PTY 自动 resume → 任务继续投递
3. **R4 测试**: 手动 `kill -9` agent PTY → 验证 30s 内自动 resume
4. **R5 测试**: `node --test tests/sprint8-wave5-6.test.js` → 13/13 pass
5. **R6 测试**: 积累 50+ completed task → 运行 prune → 验证归档文件存在 → restore → 验证恢复
6. **R7 测试**: 各 agent 启动后自动开始 check_inbox 轮询 → PM 不下发 wake → agent 仍能自动处理任务。越权任务测试: 发送 frontend 任务给平台集成 → 平台自动转发给前端。
7. **全量回归**: `node --test tests/*.test.js` → 229+/0 fail

---

*待团队探索报告回来后更新细节*

---

## Sprint 10: 生产级全自主集群 — 计划

> 目标: 补齐容错、编排、约束、知识共享四大架构缺口
> 日期: 2026-07-15 | 状态: 规划中

---

### 背景

Sprint 9 完成了 agent 全自主闭环（轮询→派发→处理→回报→唤醒），但离生产级还有 7 个架构缺口。审计发现最关键的是容错性——单个 agent 崩溃会永久阻塞任务链。

### R8: Workflow 编排引擎 E2E (P1)

**现状**: `define_workflow / add_stage / activate_workflow` 已实现但从未端到端测试。

**目标**: 验证完整 DAG 编排流程：
- PM 定义 workflow → 添加 stages + dependencies → 激活
- 系统按拓扑序自动派发 → 阶段完成后级联触发下游
- 端到端测试 + 文档

**负责人**: PM + 可靠性工程师

### R9: Agent 负载均衡 (P1)

**现状**: 自动路由只看 capability 匹配，不看 agent 当前负载。3 个任务同时路由到同一 agent。

**目标**: `send_task` 自动路由增加负载感知：
- 新增 `store.countInProgressTasks(uid)` 
- `_matchByCapability` 改为 least-loaded 优先（同 capability 下选负载最小的）
- 所有 agent 满载时 → 通用助手兜底

**修改文件**:
- `lib/agentBus/queue.js` — `_matchByCapability` 增加负载权重
- `lib/agentBus/store.js` — `countInProgressTasks`

**负责人**: PM

### R10: Agent 心跳 + 崩溃恢复 (P0)

**现状**: Agent PTY 崩溃 → 任务永久 stuck in_progress。仅靠 30min timeout 恢复。

**目标**:
- **Agent-bus 心跳**: 每个 agent 每 60s 通过 check_inbox 隐式发送心跳（已有 wait 长轮询天然心跳）。连续 3 次缺失 → 标记 unresponsive
- **任务回收**: 标记 unresponsive 时自动将 in_progress 任务 reset 为 pending，retry_count++
- **心跳扫描器**: `lib/agentBus/heartbeat.js` (NEW) — 每 30s 扫描，检测 (now - last_check_inbox) > 180s
- **agent 恢复**: agent 重新 check_inbox 时自动清除 unresponsive 标记

**修改文件**:
- `lib/agentBus/heartbeat.js` (NEW) — 心跳扫描器
- `lib/agentBus/queue.js` — checkInbox 更新 last_seen
- `lib/agentBus/store.js` — agent record 增加 last_seen_at, unresponsive
- `lib/agentBus/notifications.js` — unresponsive 时通知 PM

**负责人**: PM

### R11: 优先级抢占 (P2)

**现状**: 高优任务到达时 agent 忙于低优任务，只能排队。

**目标**:
- Agent check_inbox 时优先弹出高优任务（已实现 FIFO-per-priority ✅）
- `interrupt_task` 增加 receiver 端响应 — 被中断的 agent 收到 SSE 通知放弃当前任务
- 被中断任务回到 pending，retry_count 不增加（非失败，是被抢占）

**修改文件**:
- `lib/agentBus/handlers.js` — `_interruptTask` 通知 receiver
- `lib/agentBus/notifications.js` — `_onTaskInterrupted` 推送抢占通知

**负责人**: 平台集成工程师

### R12: 共享知识库 (P1)

**现状**: Agent 之间无共享记忆。A 解决问题后 B 从零开始。

**目标**:
- `~/.boos/knowledge/` — 多层级分类知识库
- 目录结构:
  ```
  knowledge/
  ├── architecture/    # 架构决策、设计文档
  ├── bugs/            # 已知 bug + 修复记录
  ├── patterns/        # 代码模式、最佳实践
  ├── decisions/       # 历史决策摘要（汇总）
  ├── agents/          # 各 agent 的能力/状态
  └── INDEX.md         # 全局索引
  ```
- 嵌入所有 agent CLAUDE.md: **完成每项任务后强制更新对应知识库文件**
- 新 agent 启动时先读取 INDEX.md + 对应领域目录
- REST API: `GET /api/knowledge/:path` — 读取; `PUT /api/knowledge/:path` — 更新 (agent-bus 调用)

**修改文件**:
- `lib/knowledgeBase.js` (NEW) — 知识库 CRUD
- `routes/knowledge.js` (NEW) — REST API
- `server.js` — 注册路由
- 所有 4 个 CLAUDE.md — 添加知识库更新指令
- `lib/agentBus/schemas.js` — 新增 `update_knowledge` tool

**负责人**: PM (后端) + 前端工程师 (UI 浏览)

### R13: 文件锁管理 (P1)

**现状**: 无并发文件修改控制。两个 agent 同时改同一文件 → 冲突。

**目标**: agent-bus 内置文件树管理体系：
- Agent 修改文件前 → `request_file_lock(agent_uid, file_path)` → 获取锁
- 修改完毕 → `release_file_lock(agent_uid, file_path)` → 释放锁
- **同一时间仅一个 agent 持有同一文件的写锁**
- 锁超时 5min 自动释放
- Agent 断开连接 → 持有的所有锁自动释放
- 新增 MCP tool: `request_file_lock`, `release_file_lock`, `list_file_locks`

**修改文件**:
- `lib/agentBus/fileLock.js` (NEW) — 文件锁管理器
- `lib/agentBus/schemas.js` — 新增 3 个 tool 定义
- `lib/agentBus/handlers.js` — 新增 3 个 handler
- `lib/agentBus/store.js` — locks 存储

**负责人**: 平台集成工程师

### R14: 职权硬约束路由 (P1)

**现状**: 职权路由仅靠 CLAUDE.md 文本指令，无代码层 enforcement。

**目标**: agent-bus 内核强制执行：
- `register_agent` 时声明 `capabilities` 白名单（已有 ✅）
- `send_task` 自动路由时检查 capability 匹配
- **不匹配的任务自动拆分并重分配**: 如任务要求 [frontend + testing]，系统自动创建 2 个子任务，分别路由给前端和测试
- 无 agent 匹配的任务 → 路由给 PM 做决策（不丢任务）

**修改文件**:
- `lib/agentBus/queue.js` — `sendTask` 增加 capability gating + 自动拆分
- `lib/agentBus/handlers.js` — `_sendTask` 拆分逻辑
- `lib/agentBus/schemas.js` — `send_task` schema 文档更新

**负责人**: PM

---

## 任务分配

| # | 任务 | 负责人 | 优先级 | 
|---|------|--------|:--:|
| R8 | Workflow 编排 E2E | PM + 可靠性 | P1 |
| R9 | Agent 负载均衡 | PM | P1 |
| R10 | 心跳 + 崩溃恢复 | PM | P0 |
| R11 | 优先级抢占 | 平台集成 | P2 |
| R12 | 共享知识库 | PM + 前端 | P1 |
| R13 | 文件锁管理 | 平台集成 | P1 |
| R14 | 职权硬约束路由 | PM | P1 |

## 实施顺序

```
Wave 1 (并行): R12(PM·知识库后端) + R13(平台·文件锁) + R9(PM·负载均衡)
Wave 2 (并行): R10(PM·心跳) + R14(PM·职权约束) + R8(可靠性·测试)
Wave 3 (并行): R11(平台·抢占) + R12(前端·知识库UI) + E2E 验证
```
