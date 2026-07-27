# Findings — Sprint 24-25: AutoPilot + 决策区 2.0 + TeamCompact

## 2026-07-26: 现有系统调研

### 1. 决策系统已有基础，但是阻塞式的

- `lib/decisionSystem.js` (276 行) — 完整的决策 CRUD，markdown 文件存储
- `routes/decisions.js` (199 行) — REST API: approve/reject/reply/root-respond
- `lib/agentBus/handlers.js:601-667` — `_requestDecision()` handler
- 决策文件: `~/.boos/decisions/OPEN/` → `DECIDED/`
- **问题**: `blocking_task_id` 参数导致任务进入 blocked 状态，agent 等待人类回复
- **AutoPilot 需要**: 默认不传 `blocking_task_id`，决策异步投递，agent 跳过继续

### 2. Agent Activation REST API 已实现

- `routes/agents.js:122-309` — 3 个端点全部就绪
- `POST /api/agents/wake`, `POST /api/agents/wake-all`, `GET /api/agents/status`
- 无需额外开发，可直接用于 AutoPilot 的 agent 管理

### 3. 当前 Agent 状态 (2026-07-26)

- BOOS workspace: 34 agents 注册，5 online（含 PM + HR）
- 3 个核心 agent 全部在线，Sprint 23 任务执行中
- 大量僵尸 agent（goldrush, stock-resource 等 workspace 的遗留）

### 4. 关键模块依赖关系

```
routes/agents.js  ← 本次修改点 (Phase 4: TeamCompact)
  ├── lib/agentBus/notifications.js  (wakeAgent, compactAllWorkers)
  ├── lib/agentBus/store.js          (agent lookup)
  └── lib/persistedSessions.js       (session state)

routes/goals.js  ← 新建 (Phase 1)
  └── lib/goalStore.js               (Goal CRUD)

routes/decisions.js  ← 修改点 (Phase 3: batch/defer/summary)
  └── lib/decisionSystem.js          (决策 CRUD)

lib/autoPilot.js  ← 新建 (Phase 2)
  ├── lib/goalStore.js               (读目标)
  ├── lib/agentBus/queue.js          (send_task + check completions)
  ├── lib/agentBus/store.js          (agent matching)
  └── lib/decisionSystem.js          (异常投递)
```

### 5. OpenViking 记忆策略

- AutoPilot 每完成一个任务 → OpenViking 写进度快照
- milestone reached → 写 milestone summary
- Goal 完成 → 写最终报告（含所有验收标准验证结果）
- TeamCompact 执行前 → 写 compact snapshot
