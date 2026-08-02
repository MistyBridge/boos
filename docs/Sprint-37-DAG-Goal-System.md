# Sprint 37 — DAG 目标-反馈系统 开发指南

> **版本**: 4.0 | **日期**: 2026-08-02 | **状态**: 设计中
>
> 核心原则：所有角色引用均软编码为项目组 PM，不硬编码特定 agent UID。

---

## Q&A 决策记录

### 第一轮 (2026-08-02)

| # | 问题 | 决策 |
|---|------|------|
| 1 | 用户身份 | ROOT_UID |
| 2 | PMO 定位 | 独立 Agent (A)，未指定时 PM 兼任 |
| 3 | 审查方式 | PM 对每个节点提选择题，用户决策模糊点 |
| 4 | PM 唯一性 | 每 workspace 唯一 PM |
| 5 | DAG 规模 | 大型 (30–50 节点) → dagre + 缩放 |
| 6 | proposed 可见性 | 仅提议者 + PM 可见 (C) |
| 7 | 反馈队列 | 混合队列，target_task_id 区分 (A) |
| 8 | 完成归档 | 全量存档到 archive JSONL |
| 9 | 堆积策略 | 全部堆积，逐条消费 (A) |
| 10 | Goal↔DAG 关系 | 一个 Goal = 多个 DAG (不连通复合图) |

### 第二轮 (2026-08-02)

| # | 问题 | 决策 |
|---|------|------|
| 1 | 问题不匹配 | 用户可选"以上皆不是"+自定义答案 (B) |
| 2 | 审查终止 + 启停 | 用户可跳过提问直接批准；**DAG 启停按钮由用户控制**，暂停不给新任务但执行中的继续 |
| 3 | 跨 DAG 依赖 | **不存在跨 DAG 依赖** — 有关联就该合并为一个 DAG |
| 4 | 用户通知 | BOOS 右下角弹窗 + ROOT inbox 邮件 → 自动显示在决策区 |
| 5 | 执行中修改 | 可 force 修改，修改后**重新发送给执行者** (C) |
| 6 | 多 Goal 并发 | FIFO 自然逐条消费 (A) |
| 7 | proposed 阻塞 | **阻塞当前任务**，等 PM 处理完再继续 (B) |
| 8 | 重大回滚 | **部分回滚** — 已 approved 保留，下游取消 (C) |
| 9 | PM+PMO 冲突 | **升级到 ROOT 决策区**，让人类决定 (C) |
| 10 | 原子性 | 部分成功 — 保留成功节点，返回失败列表 + 错误报告 (B) |

### 第三轮 (2026-08-02)

| # | 问题 | 决策 |
|---|------|------|
| 1 | force_modify 范围 | **全部字段可改**。改 executor 时旧成果移入 review_history |
| 2 | 激活失败处理 | 系统自动通知 PM + 生成错误信息 |
| 3 | 部分回滚方式 | **节点原子性** — 只删单个节点，不删子树。下游节点**自动断开为独立 DAG**，可重新连接 |
| 4 | Goal 完成触发 | **用户手动标记完成** (C)，然后 PM 归档 |
| 5 | Force modify 通知 | **添加到 agent-bus 任务队列 + wake**，不一次性全部推送，随 DAG 推进逐步派发 |
| 6 | 用户强制启动 | 所有未回答的 review_questions **由 agent 自由决策** |
| 7 | publisher/问题 字段 | **Phase 1 就加** |

---

## 1. 系统全景

```
                              ┌──────────────────────┐
                              │   用户 (ROOT)          │
                              │   提目标 · 回答 · 审批  │
                              │   启停 DAG · 仲裁冲突   │
                              └──────┬───────────────┘
                                     │
              goal_create / 反馈      │  BOOS 弹窗 + ROOT inbox
                                     │  PMO 冲突 → 决策区
                                     ▼
┌──────────────────────────────────────────────────────────────────┐
│                        PM (项目组 PM)                             │
│                                                                    │
│  Inbox FIFO:                                                       │
│  goal_new → feedback:node3 → feedback:overall → goal_new → ...     │
│                                                                    │
│  PM busy → 消息堆积，不 wake                                       │
│  PM idle → wake + check_inbox                                      │
└──────────────────────────────────────────────────────────────────┘
         │                                          │
         │ 协同                                     │ 派发 + 监控
         ▼                                          ▼
┌──────────────┐                        ┌──────────────────────────┐
│     PMO      │                        │      Agent 团队           │
│  协同拆解     │                        │  executor: submit 成果    │
│  审核联名     │                        │  reviewer: approve/reject │
│  (独立Agent)  │                        │  anyone: dag_propose_task │
└──────────────┘                        └──────────────────────────┘
```

### 核心流程

```
用户提 Goal → PM inbox → PM±PMO 拆解 → 生成 DAG → PM 对节点提问
  │                                                       │
  │  用户回答问题 / 跳过 / "以上皆不是"                     │
  │  ←── dag_answer_question ───────────────────────────  │
  │                                                       │
  │  用户点击 [▶ 启动 DAG]  ← 用户控制启停                 │
  │                                                       │
  │  执行中:                                               │
  │  任何人 propose → 阻塞关联任务 → PM+PMO审核 →          │
  │    一致通过 → 接入 DAG                                 │
  │    不一致   → 升级到 ROOT 决策区                        │
  │                                                       │
  │  用户暂停 → 不派发新任务，执行中的继续                  │
  │  用户启动 → 继续派发无依赖任务                          │
  │                                                       │
  │  PM force 修改执行中节点 → 重新发给执行者               │
  │                                                       │
  │  Goal 完成 → goal_archive → goals-archive.jsonl        │
```

---

## 2. 数据模型

### 2.1 Goal

```javascript
{
  goal_id: "goal_a1b2c3d4",
  title, description,
  workspace: "boos",
  project: "boos-core",
  creator_uid: "ROOT_UID",

  assigned_pm_uid: null,           // resolveProjectPM
  assigned_pmo_uid: null,          // resolveProjectPMO, null = PM 兼任

  status: enum[
    "submitted",       // 已提交
    "decomposing",     // PM 拆解中
    "review",          // 等待用户审查 (选择题阶段)
    "approved",        // 用户批准，等待启动
    "active",          // 用户已点启动，Agent 执行中
    "paused",          // 用户暂停，不派发新任务
    "completed",       // 所有 DAG 完成
    "rejected",        // 目标被拒绝
  ],

  dag_ids: [],                       // DAG ID 数组 (互不连通)

  feedback_thread: [
    {
      from_uid, from_name, content,
      timestamp,
      type: "overall | node | proposal | decision",
      target_task_id: null,
    },
  ],

  created_at, updated_at, archived_at: null,
}
```

### 2.2 DAG

```javascript
{
  dag_id, title,
  goal_id: "goal_xxx",       // 关联 Goal (新增)
  status: enum[
    "draft",        // 创建中
    "ready",        // 等待用户启动
    "active",       // 执行中
    "paused",       // 用户暂停
    "completed",
    "cancelled",
    "rolled_back",  // 部分回滚后状态 (新增)
  ],
  // ... 现有字段
}
```

### 2.3 DAG Task 节点

```javascript
{
  // === 现有 + V2 新增 ===
  task_id, dag_id, title, description,
  publisher_uid, proposal_reason, proposed_at,
  executor_uid, reviewer_uid, dependencies,
  acceptance_criteria, status, priority,
  submit_content, review_comment, review_history,
  retry_count, max_retries,
  created_at, submitted_at, reviewed_at, completed_at,

  // === V3 新增 ===
  force_modified_at: null,           // PM force 修改时间
  force_modified_by: null,           // 谁 force 修改的
  re_notified_to_executor: false,    // 是否已重新通知执行者

  review_questions: [
    {
      question_id: "q_xxx",
      question: "...",
      options: ["A", "B", "C"],
      user_choice: null,             // null | option_index | "custom:text"
      impact: "...",
      answered_at: null,
      skipped: false,                // 用户跳过 (V3)
    }
  ],

  user_notes: [],
}
```

### 2.4 完整状态机

```
Goal 状态:

submitted → decomposing → review → approved → active ←→ paused
                                       │            │
                                       └── 用户 [▶] ─┘ 用户 [⏸]
                                                  │
                                                  ↓
                                             completed → archived

DAG 状态:

draft → ready → active ←→ paused
          │       │
          │       ├── completed
          │       └── rolled_back (部分回滚)
          └── cancelled

节点状态:

proposed → pending → active → submitted ──┬── approved
              ↑        ↑                   │
              │        └── reject (打回) ──┘
              │
              └── 阻塞 (proposed 审核时原任务 blocked)
```

---

## 3. MCP 工具清单

| 分类 | 工具 | 调用者 | 说明 |
|------|------|--------|------|
| **Goal** | `goal_create` | ROOT | 创建目标 |
| | `goal_list` | 任何人 | 列表 |
| | `goal_status` | 任何人 | 目标+全部DAG+复合图 |
| | `goal_update` | PM | 更新 status/dag_ids |
| | `goal_archive` | PM | 移入归档 |
| | `goal_start` | ROOT | **启动 DAG** → active |
| | `goal_pause` | ROOT | **暂停 DAG** → paused |
| **决策** | `dag_add_questions` | PM | 对节点提选择题 |
| | `dag_answer_question` | ROOT | 回答/跳过/自定义 |
| **提议** | `dag_propose_task` | 任何人 | 提议新节点 (阻塞关联任务) |
| | `dag_approve_proposal` | PM/PMO | 批准 (一致则接入) |
| | `dag_reject_proposal` | PM/PMO | 驳回 |
| **调整** | `dag_rearrange` | PM | 调整依赖关系 |
| | `dag_force_modify` | PM | **force 修改执行中节点** → 重发执行者 |
| | `dag_partial_rollback` | PM | 部分回滚 (保留 approved，取消下游) |
| **批量** | `dag_decompose` | PM/PMO | 批量创建 DAG |
| | `dag_suggest_assignments` | 任何人 | 能力匹配建议 |
| **决策区** | `dag_escalate_conflict` | PM/PMO | PM+PMO 意见不一致 → ROOT 决策区 |

### 工具计数

| 类别 | 工具 |
|------|:--:|
| 现有 DAG | 13 |
| 新增 | 17 |
| **总计** | **30** |

---

## 4. 模块实现

### 4.1 `lib/agentBus/goalStore.js`（新建）

```
函数:
  createGoal({title, description, workspace, project, creatorUid})
  getGoal(goalId)
  listGoals(workspace, project?, status?)
  updateGoal(goalId, updates)
  addDagToGoal(goalId, dagId)

  startGoal(goalId)     → status='active', 所有 DAG→'active'
  pauseGoal(goalId)     → status='paused', 所有 DAG→'paused'
    (不中断执行中节点，仅阻止新派发)

  archiveGoal(goalId)   → 追加 JSONL, 从 goals.json 删除

  resolveProjectPM(workspace, project)   → supervisor UID
  resolveProjectPMO(workspace, project)  → pmo UID | null
```

### 4.2 `lib/agentBus/feedbackManager.js`（新建）

```
函数:
  sendFeedback({goalId, taskId, content, fromUid})
  sendDecisionAnswer({goalId, taskId, questionId, choice})
  isPmIdle(pmUid) → collaborationLoop.getAgentState
  notifyUser({goalId, message}) → ROOT inbox + 弹窗通知
```

### 4.3 核心更新

| 模块 | 新增函数 |
|------|----------|
| `dagStore.js` | approveProposal, rejectProposal, forceModifyTask, partialRollback |
| `dagDecomposer.js` | 部分成功模式 + 失败报告 |
| `queue.js` | root→PM 反馈 routing + idle 检查 |

### 4.4 冲突升级 → 决策区

```
PM+PMO 不一致:
  dag_escalate_conflict(taskId, {pm_opinion, pmo_opinion})
    → ROOT inbox metadata: {type:"dag_conflict", ...}
    → 决策区显示: "PM: X  |  PMO: Y  |  请决定"
    → ROOT 选择 → 通知双方执行
```

---

## 5. 前端组件

| 组件 | 位置 | 功能 |
|------|------|------|
| GoalListPage | /goals | 卡片列表 + 活跃/归档 tab |
| NewGoalPage | /goals/new | 创建表单 |
| GoalDetailPage | /goals/:goalId | 复合 DAG 图 + 反馈 + 启停按钮 |
| CompositeDagGraph | 嵌入 GoalDetail | dagre 布局 + SVG + 缩放 |
| DagNodeModal | 点击节点 | 4-tab 弹窗 + 选择题 + 自定义答案 |
| GoalNotification | 右下角 | BOOS 通知弹窗 |

---

## 6. 实施进度

```
Phase 1: 数据层 ✅ (2026-08-02)
  ✅ goalStore.js (新建, 280 lines)
  ✅ dagStore.js (forceModifyTask + deleteTaskNode + approveProposal + rejectProposal)
  ✅ dagDecomposer.js (publisher + review_questions + activateDag复用)

Phase 2: 反馈 + 通知 ✅ (2026-08-02)
  ✅ feedbackManager.js (新建, 160 lines)
  ✅ queue.js (getTask dagStore fallback)

Phase 3: MCP 工具 ✅ (2026-08-02)
  ✅ 16 新 schemas (schemasDag.js)
  ✅ 16 新 handlers (handlersDag.js)
  ✅ 16 dispatch entries (handlers.js)

Phase 4: 测试 📤 A2
  📤 tests/dagStore-sprint37.test.js (dagStore新函数)
  📤 tests/feedbackManager.test.js (feedbackManager)
  📤 全量回归

Phase 5: 平台验证 📤 A4
  📤 30-tool 全量审计
  📤 dag_my_tasks routing fix
  📤 SSE 通知通路

Phase 6: 前端 📤 A3
  📤 GoalListPage, NewGoalPage, GoalDetailPage
  📤 CompositeDagGraph, DagNodeModal
  📤 GoalNotification
```

### 测试基线: 74/74 pass ✅

| 测试文件 | Tests | Status |
|----------|:-----:|:------:|
| dagDecomposer.test.js | 13 | ✅ |
| dagDecomposer-integration.test.js | 34 | ✅ |
| goalStore.test.js | 27 | ✅ |
| **Total** | **74** | ✅ |

### 团队派发

| 成员 | 任务 | 状态 |
|------|------|:--:|
| A2 (可靠性) | 集成测试 + 回归 | 📤 `docs/Sprint-37-Team-Tasks.md` |
| A3 (前端) | 7 前端组件 | 📤 `docs/Sprint-37-Team-Tasks.md` |
| A4 (平台集成) | MCP 审计 + routing fix | 📤 `docs/Sprint-37-Team-Tasks.md` |
