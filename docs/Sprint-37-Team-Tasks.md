# Sprint 37 — 团队任务派发 (2026-08-02)

> PM (全栈架构师) 已完成 Phase 1-3 全部后端模块。测试: 74/74 pass。
> 以下任务待团队成员推进。

---

## A2 — 可靠性工程师
**UID**: `81c99498-c60d-4d92-8ae8-fe5ec41d5cab`

### 测试任务

1. **dagStore 新函数测试** (`tests/dagStore-sprint37.test.js`)
   - forceModifyTask: 改title/executor/description，验证review_history归档
   - deleteTaskNode: 原子删除→下游依赖断开为独立DAG，验证不级联删除子树
   - approveProposal/rejectProposal: proposed流程+blocking_task自动解block

2. **feedbackManager 单元测试** (`tests/feedbackManager.test.js`)
   - sendFeedback: PM busy时不wake，idle时wake
   - notifyUser: ROOT inbox通知
   - sendDecisionAnswer: 答案持久化验证

3. **MCP Tools 端到端验证** — 每个新tool至少一个happy-path + 权限边界测试

4. **全量回归**: `npm test` 全部pass (基线: 74/74)

---

## A3 — 前端工程师
**UID**: `90490923-dc5b-4ac8-be3f-62c3efbe2bb0`

### 前端组件

1. **GoalListPage** (`/goals`) — 卡片列表，活跃/归档tabs
2. **NewGoalPage** (`/goals/new`) — 创建表单
3. **GoalDetailPage** (`/goals/:goalId`) — DAG图+反馈+启停按钮
4. **CompositeDagGraph** — dagre+SVG，缩放/拖拽，节点颜色按status
5. **DagNodeModal** — 4 tabs: 详情/选择题/反馈/历史
6. **GoalNotification** — 右下角弹窗
7. 路由注册 (App.js) + 导航项 (Sidebar.js)

### 需调用的 MCP Tools
goal_create, goal_list, goal_status, goal_start, goal_pause,
dag_add_questions, dag_answer_question, dag_status

---

## A4 — 平台集成工程师
**UID**: `d428dd45-f2ac-40e7-8825-4e82ba98686a`

### 验证任务

1. **MCP Tool 全量审计**: 30 个 DAG tools 逐项功能验证
2. **dag_my_tasks 路由修复**: 确认 DAG 任务节点在 executor inbox 中可见
3. **SSE 通知通路**: Goal 事件是否需要新 SSE 通道
4. **循环依赖检查**: goalStore↔dagStore↔feedbackManager↔queue 依赖链

---

## 已完成 (PM)

| 模块 | 文件 | 行数 | 状态 |
|------|------|:--:|:--:|
| Goal 数据层 | `lib/agentBus/goalStore.js` | 280 | ✅ |
| 反馈管理器 | `lib/agentBus/feedbackManager.js` | 160 | ✅ |
| DAG 新函数 | `lib/agentBus/dagStore.js` | +160 | ✅ |
| 批量拆分 | `lib/agentBus/dagDecomposer.js` | 548 | ✅ |
| 16 MCP Schemas | `lib/agentBus/schemasDag.js` | +200 | ✅ |
| 16 MCP Handlers | `lib/agentBus/handlersDag.js` | +320 | ✅ |
| Dispatch | `lib/agentBus/handlers.js` | +18 | ✅ |
| Goal tests | `tests/goalStore.test.js` | 27 tests | ✅ |
| DAG tests | 47 tests | 47/47 | ✅ |

### 全量 MCP 工具: 30 tools
```
Goal (7): goal_create, goal_list, goal_status, goal_update, goal_archive, goal_start, goal_pause
Questions (2): dag_add_questions, dag_answer_question
Proposal (3): dag_propose_task, dag_approve_proposal, dag_reject_proposal
Adjustment (3): dag_rearrange, dag_force_modify, dag_partial_rollback
Conflict (1): dag_escalate_conflict
Batch (2): dag_decompose, dag_suggest_assignments (existing)
Core DAG (12): dag_create, dag_add_task, dag_activate, dag_status, dag_cancel,
              dag_submit_task, dag_approve_task, dag_reject_task,
              dag_my_tasks, dag_reassign_task, dag_list,
              dag_sleep_agent, dag_wake_agent
```

### 测试基线
```
tests/dagDecomposer.test.js:            13 pass
tests/dagDecomposer-integration.test.js: 34 pass
tests/goalStore.test.js:                 27 pass
Total:                                   74 pass / 0 fail
```
