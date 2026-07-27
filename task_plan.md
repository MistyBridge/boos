# Sprint 24-25: AutoPilot 无人化执行 + 决策区 2.0 + TeamCompact

> **目标**: 你只需给目标，PM 生成验收标准 → 团队自主推进至全部完成。中途不阻塞，问题异步投递决策区。里程碑到达时 PM 一键全员 compact。

---

## 当前状态

| 功能 | 现状 | 缺口 |
|------|------|------|
| 任务派发 | PM 手动 send_task | 无自主循环 |
| Sprint 计划 | 无持久化，靠 PM 记忆 | 无 Goal Schema |
| 决策系统 | `request_decision` + `~/.boos/decisions/` | **阻塞式** — blocking_task_id 会让 agent 等待 |
| 上下文管理 | 每个 agent 独立 `/compact` | 无全员协同 compact |
| 进度追踪 | OpenViking 手动写入 | 无自动化进度报告 |

---

## Phase 1: Sprint Plan Schema + Goals API

### 新增数据结构

```js
// ~/.boos/goals.json — 持久化的目标列表
{
  "goal_id": "goal_001",
  "workspace": "boos",
  "title": "PWA 离线模式",
  "description": "实现 Service Worker 缓存，断网可访问",
  "acceptance_criteria": [
    { "id": "ac1", "text": "断网后页面可正常加载", "verified": false },
    { "id": "ac2", "text": "已缓存的 sessions 数据可见", "verified": false },
    { "id": "ac3", "text": "Lighthouse PWA 评分 ≥ 90", "verified": false }
  ],
  "milestones": [
    { "id": "m1", "title": "SW 注册 + Shell 缓存", "task_ids": ["t1"], "reached": false },
    { "id": "m2", "title": "全离线可用", "task_ids": ["t2","t3","t4"], "reached": false }
  ],
  "tasks": [
    {
      "task_id": "t1", "title": "注册 SW + 预缓存 shell",
      "assignee": "前端工程师", "status": "pending",
      "depends_on": [], "acceptance_criteria": ["ac1"],
      "agent_task_id": null  // populated after send_task
    }
  ],
  "status": "active",  // active | completed | paused
  "created_at": "...", "completed_at": null
}
```

### 新增 API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/goals` | 创建新目标（PM only） |
| GET | `/api/goals` | 列出 workspace 所有目标 |
| GET | `/api/goals/:id` | 单个目标详情 + 任务进度 |
| PUT | `/api/goals/:id` | 更新目标（PM only） |
| POST | `/api/goals/:id/activate` | 激活 AutoPilot 模式 |

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/goalStore.js` | **新建** | Goal CRUD + JSON 持久化 |
| `routes/goals.js` | **新建** | REST endpoints |
| `server.js` | 改 1 行 | 注册 goals 路由 |

---

## Phase 2: AutoPilot Engine — 自主执行引擎

### 核心循环（运行在 PM session 内）

```
User: POST /api/goals { title: "PWA 离线", criteria: [...], tasks: [...] }
User: POST /api/goals/:id/activate  ← 启动 AutoPilot

PM enters AutoPilot Loop:
┌─────────────────────────────────────────────────────────┐
│  while (goal.status === 'active') {                      │
│                                                          │
│    // 1. 找所有就绪任务（依赖满足 + 未派发）               │
│    ready = goal.tasks.filter(t =>                         │
│      t.status === 'pending' &&                            │
│      t.depends_on.every(depId =>                          │
│        goal.tasks.find(d => d.id === depId)?.status       │
│          === 'completed'                                  │
│      )                                                    │
│    )                                                      │
│                                                          │
│    // 2. 派发就绪任务                                     │
│    for (t of ready) {                                     │
│      result = send_task(matchAgent(t), t.title + desc)   │
│      t.agent_task_id = result.task_id                    │
│      t.status = 'dispatched'                              │
│      saveGoal(goal)                                       │
│    }                                                      │
│                                                          │
│    // 3. 等下一个 completion                              │
│    next = await check_inbox()  // 阻塞等待 respond_task   │
│                                                          │
│    // 4. 处理完成                                         │
│    task = goal.tasks.find(t => t.agent_task_id === next.reply_to) │
│                                                          │
│    // 4a. 验证结果 vs 验收标准                            │
│    if (validateResult(task, next.result)):                │
│      task.status = 'completed'                            │
│      checkMilestones(goal)  // 标记 reached 的 milestone  │
│    else:                                                  │
│      task.status = 'needs_revision'                       │
│      send_task(task.assignee, "修改: " + feedback)        │
│                                                          │
│    // 5. 异常处理                                         │
│    if (agentFailed || timeout):                           │
│      → request_decision(NON_BLOCKING)  // 投递决策区      │
│      → task.status = 'blocked'                            │
│      → CONTINUE (不停止！)                                │
│                                                          │
│    // 6. 全部完成？                                       │
│    if (goal.tasks.every(t => t.status === 'completed')):  │
│      → 最终验收（检查所有 acceptance_criteria）           │
│      → goal.status = 'completed'                          │
│      → write OpenViking summary                           │
│      → report to user: "🎉 目标达成"                     │
│      → break                                              │
│  }                                                        │
└─────────────────────────────────────────────────────────┘
```

### 关键原则

1. **永不阻塞**: `request_decision` 不再传 `blocking_task_id`，任务标记为 `blocked` 但循环继续
2. **迟绑定的阻塞任务**: `blocked` 任务暂不派发，等其他任务完成后重试；human 回复后自动恢复为 `pending`
3. **验收自检**: 每个任务完成后，让执行 agent 自检验收标准 → 再让可靠性工程师交叉验证
4. **进度可见**: 每完成一个任务，写 OpenViking 进度快照

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/autoPilot.js` | **新建** | AutoPilot 循环引擎 |
| `lib/agentBus/schemas.js` | 改 | request_decision: blocking_task_id 改为 optional，文档标注 NON_BLOCKING |
| `lib/supervisorPrompt.js` | 改 | 新增 AutoPilot 模式 prompt |
| PM `CLAUDE.md` | 改 | AutoPilot 启动流程 |

---

## Phase 3: 决策区 2.0 — 异步非阻塞审查队列

### 设计变更

```
旧模型（阻塞）:
  Agent → request_decision(blocking_task_id=xxx) → 任务 blocked → 人回答 → unblock
  问题: Agent 必须等待，人工必须在线

新模型（异步）:
  Agent → request_decision(task_id=xxx, blocking=false)
       → 决策写入 ~/.boos/decisions/OPEN/
       → 任务标记 blocked，agent 跳过继续执行
       → 人空闲时查看决策区 → 回答
       → answer → send_task → agent 的 inbox → agent 重试该任务
       → 任务自动 unblock，重新进入就绪队列
```

### 决策区增强

| 功能 | 现状 | 新增 |
|------|------|------|
| 决策列表 | `GET /api/decisions` | 加 `?workspace=boos&status=open` 过滤 |
| 决策详情 | `GET /api/decisions/:id` | ✅ 已有 |
| 批准/驳回 | `POST /api/decisions/:id/approve\|reject` | ✅ 已有 |
| **批量审核** | ❌ | `POST /api/decisions/batch` — 一次审批多个 |
| **Defer** | ❌ | `POST /api/decisions/:id/defer` — "稍后处理"，不改变任务状态 |
| **优先级排序** | ❌ | 按 urgent + created_at 排序，绑定任务的决策优先显示 |
| **决策区摘要** | ❌ | `GET /api/decisions/summary` — 各 workspace 待处理数 |
| **Feishu 通知** | urgent=true | 保持不变 |

### 新 API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/decisions/batch` | `{ decisions: [{id, action, comment}] }` |
| POST | `/api/decisions/:id/defer` | 标记为 deferred，30min 后重新提醒 |
| GET | `/api/decisions/summary` | `{ boos: {open:3,urgent:1}, goldrush: {open:12,urgent:4} }` |

### 决策区 UI（前端 — 后续 Phase）

```
┌─ Decision Dashboard ──────────────────────────────────┐
│  [boos] 3 open · [goldrush] 12 open                    │
│                                                        │
│  🔴 Urgent  标题           Agent      时间    操作      │
│  ────────────────────────────────────────────────────  │
│  🔴          端口冲突      平台集成    2min   [批准][驳回]│
│  ⚪          CSS 方案选择   前端工程师  15min  [批准][驳回]│
│  ⚪          测试框架选型   可靠性     1h     [批准][驳回]│
│                                                        │
│  [批量批准] [全部 Defer]                                │
└────────────────────────────────────────────────────────┘
```

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `routes/decisions.js` | 改 | 新增 batch/defer/summary 端点 |
| `lib/decisionSystem.js` | 改 | defer 逻辑 + batch 操作 |
| `lib/agentBus/handlers.js` | 改 | _requestDecision 默认不阻塞 |
| `public/js/pages/DecisionPage.js` | **新建** | 决策区仪表盘 |
| `public/js/components/DecisionCard.js` | **新建** | 决策卡片 |

---

## Phase 4: TeamCompact — 里程碑全员休整

### 触发条件（4 项 Gate）

```
1. caller.role === "supervisor"
2. workspace 所有 worker 的 active_tasks 中无 in_progress
3. 至少一个 milestone.reached === true
4. 所有 agent 有活跃 PTY
```

### REST API

```
POST /api/agents/compact
  Body: { workspace: "boos", milestone: "m1", note: "SW Shell 缓存完成" }
  
  → 200: { ok: true, compacted: 3, milestone_recorded: true,
           agents: [{uid, name, compacted: true}, ...] }
  → 400: { error: "agents still busy: [前端工程师]" }
  → 403: { error: "supervisor only" }
```

### 执行流程

```
1. 权限检查
2. idle 检查（gate）
3. 写 OpenViking: milestone 摘要 + 当前目标进度
4. 标记 milestone.compacted_at = now
5. 逐个 PTY 注入 "/compact\n"
6. 返回结果
```

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `routes/agents.js` | 改 | 新增 `POST /api/agents/compact` |
| `lib/agentBus/notifications.js` | 改 | 新增 `compactAllWorkers()` 函数 |

---

## Phase 5: 前端 — Goal 进度面板 + 决策仪表盘

| 页面 | 内容 |
|------|------|
| **Goal 进度面板** | 目标列表 → 展开看任务状态（pending/dispatched/completed/blocked）、里程碑进度条、验收标准勾选 |
| **决策仪表盘** | 按 workspace 分组的待处理决策、一键 approve/reject/defer、批量操作 |

---

## Phase 6: E2E 验证

1. 定义目标 → PM 生成 5 个任务 → activate → 团队自主完成全部
2. 中途制造 blocked 场景 → 验证决策区异步投递 + PM 不停止
3. 人类 approve 决策 → 验证任务自动恢复
4. milestone reached → PM 触发 TeamCompact → 全员 compact

---

## 实现顺序

| Phase | 内容 | 预估 | 负责人 | 依赖 |
|-------|------|------|--------|------|
| **P1** | Goal Schema + `lib/goalStore.js` + `routes/goals.js` | 2h | PM | — |
| **P2** | AutoPilot Engine (`lib/autoPilot.js`) + supervisorPrompt | 3h | PM | P1 |
| **P3** | 决策区 2.0 (batch/defer/summary + non-blocking) | 2h | PM | — |
| **P4** | TeamCompact (`POST /api/agents/compact`) | 1h | PM | — |
| **P5** | 前端: Goal 进度面板 | 2h | 前端工程师 | P1 |
| **P6** | 前端: 决策仪表盘 | 2h | 前端工程师 | P3 |
| **P7** | E2E 验证 + 回归测试 | 1h | 可靠性工程师 | P1-P6 |

**总预估: 13h，约 2 个 Sprint**

---

## 验收标准

1. ✅ 用户在 BOOS 前端或 API 定义一个 Goal（标题 + 验收标准 + 任务列表）
2. ✅ `POST /api/goals/:id/activate` 后 PM 进入 AutoPilot 循环
3. ✅ AutoPilot 自动派发就绪任务、等待完成、验证结果、继续下一波
4. ✅ 中途异常（agent 失败/超时/不确定）→ request_decision 不阻塞 → PM 跳过继续
5. ✅ 人在决策区 approve/reject → 任务恢复 → PM 在下一轮自动拾取
6. ✅ 全部任务完成 → PM 最终验收 → 写 OpenViking → report to user
7. ✅ milestone reached + 全员 idle → PM 触发 TeamCompact → 全员 /compact
8. ✅ npm test 零回归
