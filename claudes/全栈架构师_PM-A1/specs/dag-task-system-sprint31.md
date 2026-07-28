# Sprint 31 — DAG 任务系统 + PMO 架构 + 决策升级链

> **状态**: 规划阶段 | **日期**: 2026-07-28 | **作者**: 全栈架构师_PM-A1
> **依赖**: Sprint 30 (UID 统一索引)

---

## 一、架构总览

### 1.1 当前 vs 目标

```
现状 (信件系统):
  人类 → PM → send_task(自然语言) → agent → respond_task(自然语言) → PM
  问题: 无结构、无验收、无 DAG、无质量门

目标 (DAG 任务系统):
  人类(一次需求) → PM + PMO(生成 DAG → 分发 → 审核 → 验收)
                       ↑              ↓
                   PMO(健康检查)   agent集群(executor/reviewer 分离)
                       ↓              ↓
                  异常升级链: agent → PM → PMO → 人类决策区
```

### 1.2 新增模块

```
lib/agentBus/
├── dagStore.js        # 新: DAG 图 + 任务节点持久化
├── dagEngine.js       # 新: DAG 生命周期引擎 (激活/解锁/完成判断)
├── taskSystem.js      # 新: 任务提交/审核状态机 + 权限硬编码
├── pmoEngine.js       # 新: PMO 轮询/健康检查/PM 故障恢复
├── sleepManager.js    # 新: 休眠/唤醒生命周期 + 5min 定时器
├── fileTree.js        # 新: 文件写权限管理 (可排期到 Sprint 32)
├── schemas.js         # 改: 新增 DAG/任务/审核 MCP tools
├── handlers.js        # 改: 新增 handler 函数
├── store.js           # 改: 扩展 agent-bus.json schema
├── notifications.js   # 改: DAG 任务生命周期事件
└── transport.js       # 改: 新增 SSE 事件类型

routes/
└── agents.js          # 改: 新增 sleep/poll/compact 端点

server.js              # 改: 注册新路由
```

### 1.3 Agent 角色扩展

| 角色 | 注册 role | 权限 |
|------|----------|------|
| PM (我) | `supervisor` | DAG 生成、任务分发、审核决策、全员休眠控制、架构决策 |
| PMO | `pmo` | PM 故障恢复、健康轮询、PM 休眠控制、辅助 DAG 审核 |
| 执行者 | `worker` | 认领任务、提交成果 (仅有 submit 权) |
| 审核者 | `worker` | 审核任务、通过/打回 (仅有 approve/reject 权) |

> **约束**: PMO 不替代 PM 的架构决策权。PMO 是运营角色，PM 是决策角色。

---

## 二、数据模型

### 2.1 DAG (开发任务图)

```jsonc
// ~/.boos/agent-bus.json 新增字段
{
  "dags": {
    "dag_<uuid>": {
      "dag_id": "dag_a1b2c3d4",
      "title": "BOOS 暗色模式",
      "description": "人类原始需求描述",
      "requester": "human",                // "human" | agent_uid
      "workspace": "boos",
      "status": "active",                  // draft | active | completed | cancelled
      "created_by": "agent_5tJxrPyDOErB", // PM uid
      "created_at": "2026-07-28T10:00:00Z",
      "completed_at": null,
      "task_count": 4,
      "approved_count": 0
    }
  },
  "dag_tasks": {
    "task_<uuid>": {
      "task_id": "task_e5f6g7h8",
      "dag_id": "dag_a1b2c3d4",
      "title": "CSS tokens 扩展",
      "description": "在 tokens.css 中新增 18 个暗色变量",
      "executor_uid": "agent_XlkuC2xcWqn4",   // A3
      "reviewer_uid": "agent_DcrCqj4G_UjI",    // A2
      "dependencies": [],                       // [task_id, ...] 前置任务 ID 列表
      "acceptance_criteria": "所有组件 --dark 模式下对比度 ≥ 4.5:1，npm test 全通过",
      "status": "pending",                      // 见状态机
      "priority": "normal",                     // low | normal | high
      "submit_content": null,                   // 执行人提交内容 (markdown)
      "submit_attachments": null,               // [{type:"file",path:"...",summary:"..."}]
      "review_comment": null,                   // 打回时的修改建议
      "review_history": [],                     // [{action,uid,timestamp,comment}]
      "retry_count": 0,                         // 打回次数
      "max_retries": 3,                         // 最大打回次数
      "created_at": "2026-07-28T10:05:00Z",
      "activated_at": null,
      "submitted_at": null,
      "reviewed_at": null,
      "completed_at": null
    }
  }
}
```

### 2.2 硬编码约束 (store 层校验)

```javascript
// dagStore.js 写入前校验
function validateTaskNode(task) {
  // 1. 执行人和审核人不能是同一个 agent
  if (task.executor_uid === task.reviewer_uid) {
    throw new Error('executor and reviewer must be different agents');
  }
  // 2. 依赖不能包含自身
  if (task.dependencies.includes(task.task_id)) {
    throw new Error('task cannot depend on itself');
  }
  // 3. 依赖必须存在于同一 DAG 内
  for (const depId of task.dependencies) {
    const dep = getTask(depId);
    if (!dep) throw new Error(`dependency ${depId} not found`);
    // 4. 不能有循环依赖
    if (detectCycle(task.task_id, depId)) {
      throw new Error('circular dependency detected');
    }
  }
}
```

---

## 三、任务状态机

```
                         ┌──────────────────────────────────────┐
                         │            PM 创建任务               │
                         │         status = "pending"           │
                         └────────────────┬─────────────────────┘
                                          │
                          ┌───────────────┴───────────────┐
                          │ 依赖检查 (dagEngine)           │
                          │ 所有 dependencies 都是         │
                          │ "approved" 状态?               │
                          └───────────────┬───────────────┘
                                  YES ↓           ↓ NO (等待)
                         ┌────────────────┐      ┌──────────┐
                         │ status="active" │      │  pending │
                         │ executor 收到   │      │  (等待)  │
                         │ SSE + PTY 通知  │      └──────────┘
                         └───────┬────────┘
                                 │
                    executor 开始工作
                    (申请文件写权限, 编码, 测试)
                                 │
                                 ↓
                         ┌─────────────────┐
                         │ status=          │
                         │ "submitted"      │
                         │ executor 调用    │
                         │ dag_submit_task  │
                         └───────┬─────────┘
                                 │
                    reviewer 收到审核通知
                    (SSE + PTY)
                                 │
                    ┌────────────┴────────────┐
                    ↓                         ↓
            ┌──────────────┐         ┌──────────────┐
            │ status=       │         │ status=       │
            │ "approved"    │         │ "active"      │
            │ reviewer 调用 │         │ reviewer 调用 │
            │ dag_approve   │         │ dag_reject    │
            │                │         │ + 修改建议    │
            └──────┬─────────┘         └──────┬───────┘
                   ↓                          ↓
            下游依赖检查              executor 重新执行
            (解锁下游)               retry_count++
                   │                 max_retries 后
                   │                 强制升级给 PM
                   ↓
            ┌──────────────┐
            │ dagEngine:   │
            │ DAG 内所有    │
            │ task 都是     │
            │ "approved"?  │
            └──────┬───────┘
           YES ↓      ↓ NO
       ┌────────┐  ┌──────────┐
       │ DAG    │  │ 继续分发 │
       │ 完成   │  │ 下游任务 │
       │ 通知PM │  └──────────┘
       └────────┘
```

### 3.1 状态转换权限矩阵 (硬编码在 taskSystem.js)

| 操作 | 调用工具 | executor | reviewer | PM | PMO | 系统 |
|------|---------|:---:|:---:|:---:|:---:|:---:|
| 创建任务 | `dag_create_task` | ❌ | ❌ | ✅ | ✅ | ❌ |
| 激活任务 | — (自动) | ❌ | ❌ | ❌ | ❌ | ✅ |
| 提交成果 | `dag_submit_task` | ✅ | ❌ | ❌ | ❌ | ❌ |
| 审核通过 | `dag_approve_task` | ❌ | ✅ | ❌ | ❌ | ❌ |
| 打回重做 | `dag_reject_task` | ❌ | ✅ | ❌ | ❌ | ❌ |
| 取消任务 | `dag_cancel_task` | ❌ | ❌ | ✅ | ✅ | ❌ |
| 更换执行人 | `dag_reassign_task` | ❌ | ❌ | ✅ | ❌ | ❌ |
| 更换审核人 | `dag_reassign_task` | ❌ | ❌ | ✅ | ❌ | ❌ |
| 打回超限升级 | — (自动) | ❌ | ❌ | ❌ | ❌ | ✅ |

### 3.2 打回重做机制

```
retry_count = 0 → 执行 → submit → reject → retry_count = 1
retry_count = 1 → 执行 → submit → reject → retry_count = 2  
retry_count = 2 → 执行 → submit → reject → retry_count = 3
retry_count = 3 (=== max_retries) → 系统自动:
  ├─ 标记 status = "escalated"
  ├─ 通知 PM: "task_xxx 已被打回 3 次，执行人/审核人存在分歧"
  └─ PM 决定: 更换执行人 / 更换审核人 / 重设验收标准 / 提交人类决策
```

### 3.3 与旧信件系统的关系

```
旧系统 (保留不变):
  send_task / respond_task / check_inbox → 轻量通讯、快速问答、非结构化

新 DAG 系统 (独立体系):
  dag_create / dag_add_task / dag_activate
  dag_submit_task / dag_approve_task / dag_reject_task
  → 结构化开发任务、执行/审核分离、DAG 依赖管理

两者共存:
  - 开发任务 → DAG 系统
  - 简单通讯 ("帮我看看这个函数") → 信件系统
  - DAG 任务执行过程中的协作讨论 → 信件系统 (轻量、不计入 DAG)
```

---

## 四、新增 MCP 工具

### 4.1 DAG 管理 (PM + PMO)

```yaml
dag_create:
  description: 创建一个新的 DAG 开发任务图。PM/PMO 将人类的模糊需求分解为结构化任务图。
  params:
    title: string (required) - DAG 标题
    description: string (required) - 人类原始需求
    workspace: string - workspace 名
  returns: { dag_id, title, status: "draft" }
  auth: supervisor | pmo

dag_add_task:
  description: 向 DAG 添加一个子任务节点。系统自动校验 executor != reviewer 及循环依赖。
  params:
    dag_id: string (required)
    title: string (required)
    description: string (required)
    executor_uid: string (required)
    reviewer_uid: string (required)
    dependencies: string[] - 前置 task_id 列表
    acceptance_criteria: string (required)
    priority: "low" | "normal" | "high"
  returns: { task_id, dag_id, status: "pending" }
  auth: supervisor | pmo
  throws: executor==reviewer 冲突 / 循环依赖 / 依赖不存在

dag_activate:
  description: 激活 DAG，开始自动分发无依赖任务。DAG 状态从 draft 变为 active。
  params:
    dag_id: string (required)
  returns: { dag_id, status: "active", ready_tasks: [...task_ids] }
  auth: supervisor | pmo

dag_status:
  description: 查询 DAG 的完整状态，包括所有任务节点和依赖关系。
  params:
    dag_id: string (required)
  returns: { dag, tasks[], summary: {total, pending, active, submitted, approved, rejected} }

dag_cancel:
  description: 取消整个 DAG。所有未完成任务标记为 cancelled。
  params:
    dag_id: string (required)
    reason: string (required)
  auth: supervisor | pmo
```

### 4.2 任务操作 (全角色)

```yaml
dag_submit_task:
  description: 执行人提交任务成果。只有 executor 可以提交自己的任务。
  params:
    task_id: string (required)
    content: string (required) - 提交说明 (markdown)
    attachments: array (optional) - [{type, path, summary}]
  auth: 仅 task.executor_uid === caller.uid
  effect: status pending|active → submitted

dag_approve_task:
  description: 审核人通过任务。核对所有 acceptance_criteria 后批准。只有 reviewer 可以批准。
  params:
    task_id: string (required)
    comment: string (optional) - 审核评语
  auth: 仅 task.reviewer_uid === caller.uid
  effect: status submitted → approved → 触发下游解锁

dag_reject_task:
  description: 审核人打回任务。必须附修改建议。只有 reviewer 可以打回。
  params:
    task_id: string (required)
    comment: string (required) - 修改建议
  auth: 仅 task.reviewer_uid === caller.uid
  effect: status submitted → active, retry_count++

dag_my_tasks:
  description: 查询当前 agent 作为执行人或审核人的所有 DAG 任务。
  returns: { as_executor: [...tasks], as_reviewer: [...tasks] }

dag_reassign_task:
  description: PM/PMO 更换任务的执行人或审核人。
  params:
    task_id: string (required)
    new_executor_uid: string (optional)
    new_reviewer_uid: string (optional)
  auth: supervisor | pmo
```

### 4.3 休眠控制 (PM + PMO)

```yaml
dag_sleep_agent:
  description: 让指定 agent 休眠 (注入 /compact)。仅 PM 可休眠 worker，仅 PMO 可休眠 PM。
  params:
    target_uid: string (required)
    wake_after_minutes: number (default: 5)
  auth: 休眠 worker → supervisor, 休眠 PM → pmo
  effect: PTY 注入 /compact\r → 启动 5min 定时器 → 自动 wake

dag_wake_agent:
  description: 立即唤醒休眠中的 agent。
  params:
    target_uid: string (required)
  effect: 取消休眠定时器 → PTY 注入 check_inbox\r
```

### 4.4 PMO 专用

```yaml
pmo_poll:
  description: PMO 检查全团队状态。若全员 idle，自动询问 PM 进度。若 PM 无响应，启动故障恢复。
  returns: { team_status[], pm_responsive: bool, action_taken: string }
  auth: pmo only
```

---

## 五、新增 BOOS REST 端点

### 5.1 路由注册 (`routes/agents.js`)

```javascript
// POST /api/agents/sleep — 休眠指定 agent
// Body: { uid: string, wake_after_minutes?: number }
// Auth: 从 x-agent-uid header 鉴权 (supervisor→worker, pmo→supervisor)
app.post('/api/agents/sleep', asyncH(async (req, res) => { ... }));

// POST /api/agents/poll — PMO 全团队轮询
// Body: { workspace: string }
// Auth: 严格校验 caller.role === 'pmo'
app.post('/api/agents/poll', asyncH(async (req, res) => { ... }));

// POST /api/agents/compact — 手动触发 /compact (保留旧端点，加鉴权)
// Body: { uid: string }
// Auth: supervisor→worker, pmo→supervisor
app.post('/api/agents/compact', asyncH(async (req, res) => { ... }));
```

### 5.2 Sleep/Wake 生命周期时序

```
PM 调用 dag_sleep_agent(target_uid=A3)
    ↓
sleepManager.sleep(uid=A3, wake_after_minutes=5)
    ├─ _findSessionByUid(A3) → 找到 PTY
    ├─ _injectCommand(sid, '/compact')
    ├─ 记录: _sleeping.set(A3, { since: now, wakeAt: now+5min, timer })
    ├─ 推送 SSE 事件: "agent A3 entering sleep mode"
    └─ 返回 { ok: true, sleeping: true, wake_at: "..." }
    │
    ↓ 5 分钟后
sleepManager 定时器触发
    ├─ _injectCommand(sid, 'check_inbox')
    ├─ _sleeping.delete(A3)
    ├─ 推送 SSE: "agent A3 woke up"
    └─ PMO 下次 poll 检测到 A3 已恢复
```

---

## 六、决策升级链

### 6.1 三级升级链路

```
┌─ 第一级: Agent 自主 ─────────────────────────────────────┐
│  agent 遇到阻塞 → 先自己尝试解决                          │
│  例: 端口冲突 → 换端口重试                                │
│  超时: 3 次重试或 5 分钟                                  │
└────────────────────┬─────────────────────────────────────┘
                     ↓ 无法解决
┌─ 第二级: PM 辅助决策 ────────────────────────────────────┐
│  agent 调用 send_task(to_uid=PM, content="阻塞说明")      │
│  PM 分析 → 给出方案                                       │
│  例: "该端口被占用，换 7781" / "跳过这个测试，后续补"     │
│  超时: PM 5 分钟内回复                                    │
└────────────────────┬─────────────────────────────────────┘
                     ↓ PM 无法决策 或 PM 无响应
┌─ 第三级: PMO 辅助决策 ───────────────────────────────────┐
│  PMO 介入分析                                             │
│  可决策范围: 运维类、资源类、调度类                        │
│  不可决策: 架构方向、技术选型                              │
│  超时: PMO 3 分钟内回复                                   │
└────────────────────┬─────────────────────────────────────┘
                     ↓ PMO 也无法决策
┌─ 第四级: 人类决策区 ─────────────────────────────────────┐
│  PMO 调用 request_decision(blocking_task_id=X)            │
│  阻塞相关 DAG 任务                                        │
│  人类回复 → SSE 推送 → agent 继续执行                     │
│  包含完整升级链上下文 (agent→PM→PMO 的分析和尝试)         │
└──────────────────────────────────────────────────────────┘
```

### 6.2 PM System Prompt 权重调整

```
当前 PM CLAUDE.md 决策指令:
  "需要人类决策 → request_decision"

调整为:
  "遇到阻塞时决策升级优先级:
   1. 技术类阻塞 → 自己分析并给出方案 → 直接告诉 agent
   2. 方向/架构不确定性 → 先判断风险等级:
      低风险(端口选择、参数调整) → 自己决定
      中风险(技术选型变体) → 自己决定 + request_decision(非阻塞)
      高风险(架构方向、数据库选型) → request_decision(blocking=true)
   3. 无法判断风险等级 → request_decision(blocking=false, 附分析)
   
   核心原则: 宁可多申请决策，不可盲猜方向。每盲猜一次错误方向，
   浪费的是整个 DAG 的 agent × 小时。"
```

---

## 七、PMO 引擎

### 7.1 PMO 职责

| 职责 | 频率 | 说明 |
|------|------|------|
| 健康轮询 | 每 5 分钟 | 检查全员 agent 在线状态 + 任务进度 |
| 全员 idle 检测 | 每轮 poll | 若全部 idle → 询问 PM: "是否有新 DAG？当前进度？" |
| PM 故障检测 | 每轮 poll | PM 连续 2 次无响应 → 标记 PM 为故障 |
| PM 故障恢复 | 检测到故障后 | `launch_agent_session(PM_uid)` → 等 30s → 重试 poll |
| PM 休眠控制 | PM 全部空闲时 | `dag_sleep_agent(PM_uid)` → 5min 后自动 wake |
| 汇总报告 | PM 每次请求时 | 提供全团队状态快照 |
| 打回超限升级 | 事件驱动 | task retry_count > max_retries → 通知 PM |
| 任务超时监控 | 持续 | 任务 active 超过 30min → 提醒 PM |
| 决策区管理 | 被动 | PMO 不在决策路径上，仅 PM 不可用时写入人类决策区 |

### 7.2 PMO 注册

```javascript
// pmoEngine.js 初始化时自动注册
const pmoResult = await registry.registerAgent({
  name: 'PMO',
  intro: 'BOOS 项目管理办公室 — PM 的运营副手。负责团队健康检查、任务进度追踪、PM 故障恢复。',
  workspace: ws,
  role: 'pmo',           // 新角色
  capabilities: ['operations', 'monitoring', 'coordination'],
});
```

### 7.3 PMO 轮询循环

```
每 5 分钟:
  │
  ├─ 获取 workspace 所有 agent
  ├─ 对每个 agent:
  │   ├─ 检查 PTY 是否 alive
  │   ├─ 检查是否有 in_progress DAG 任务
  │   └─ 汇总状态: {uid, name, online, active_tasks[], idle}
  │
  ├─ 判断: 所有 worker 是否 idle?
  │   YES → 通过 SSE/PTY 询问 PM:
  │          "[PMO 轮询] 全员空闲。当前 DAG 进度？是否有新任务？"
  │          等待 PM 响应 (最多 60s)
  │          ├─ PM 响应 → 记录 → 继续
  │          └─ PM 无响应 → pmFailureCount++
  │
  ├─ PM 故障检测:
  │   pmFailureCount >= 2 → PMO 执行恢复:
  │     ├─ launch_agent_session(PM_uid)  
  │     ├─ 等 30s
  │     ├─ wake_agent(PM_uid)
  │     ├─ 再等 30s → poll PM 确认恢复
  │     └─ PM 仍未响应 → request_decision("PM 故障，无法自动恢复")
  │
  └─ 推送 poll 报告到 SSE 前端
```

---

## 八、文件写权限系统 (Sprint 32 排期)

### 8.1 设计概要

```
agent 需要写文件
    ↓
dag_request_file_write(file_path, intent, estimated_duration)
    ↓
fileTree.acquire(file_path, agent_uid, intent, ttl=10min)
    ├─ 文件未被占用 → 授予写锁
    ├─ 文件被占用 → 返回 {granted:false, holder, intent, remaining}
    └─ agent 可选择: 等待 / 找持有者协调 / 换文件
    ↓
agent 完成写入
    ↓
dag_release_file_write(file_path)
    ↓
fileTree.release(file_path, agent_uid)
```

### 8.2 文件树视图

```
GET /api/files/tree?workspace=boos
    → {
        "server.js":     { holder: "agent_XlkuC2xcWqn4", intent: "添加 sleep 路由", since: "..." },
        "lib/dagStore.js": { holder: null },
        "public/js/...":   { holder: null },
      }
```

每个 agent 可看到整个项目的文件占用情况，避免冲突。

---

## 九、实现阶段

### Phase 1: DAG 数据层 (P0 — 地基)
- **文件**: `dagStore.js`, `store.js` (扩展)
- **内容**: DAG + dag_tasks 数据模型、CRUD、硬编码校验
- **测试**: 校验规则单元测试 (executor!=reviewer, 循环依赖检测)

### Phase 2: 任务状态机 (P0 — 核心)
- **文件**: `taskSystem.js`, `schemas.js`, `handlers.js`
- **内容**: submit/approve/reject 状态转换 + 权限硬编码
- **测试**: 状态转换矩阵测试、权限越权测试

### Phase 3: DAG 引擎 (P0 — 编排)
- **文件**: `dagEngine.js`, `notifications.js`
- **内容**: 依赖解锁、DAG 完成判断、SSE 事件推送
- **测试**: 依赖链解锁测试、并行任务测试

### Phase 4: PMO 引擎 (P1)
- **文件**: `pmoEngine.js`, `routes/agents.js`
- **内容**: PMO 注册、轮询循环、PM 故障检测与恢复
- **测试**: PMO 轮询测试、PM 故障恢复测试

### Phase 5: 决策升级链 (P1)
- **文件**: PM 的 `CLAUDE.md`, `notifications.js`
- **内容**: 三级升级链、PM 决策权重调整、request_decision 增强
- **测试**: 升级链端到端测试

### Phase 6: Sleep/Wake 管理 (P2)
- **文件**: `sleepManager.js`, `routes/agents.js`
- **内容**: /compact 注入、5min 定时器、权限控制
- **测试**: Sleep/wake 生命周期测试

### Phase 7: 文件写权限 (Sprint 32 排期)
- **文件**: `fileTree.js`
- **内容**: 写锁获取/释放、文件树视图、意图标签

---

## 十、文件变更清单

| 文件 | 操作 | 预估行数 | Phase |
|------|------|---------|:---:|
| `lib/agentBus/dagStore.js` | 新建 | ~250 | 1 |
| `lib/agentBus/taskSystem.js` | 新建 | ~200 | 2 |
| `lib/agentBus/dagEngine.js` | 新建 | ~180 | 3 |
| `lib/agentBus/pmoEngine.js` | 新建 | ~200 | 4 |
| `lib/agentBus/sleepManager.js` | 新建 | ~120 | 6 |
| `lib/agentBus/fileTree.js` | 新建 | ~150 | 7 |
| `lib/agentBus/schemas.js` | 改 | ~200 | 2 |
| `lib/agentBus/handlers.js` | 改 | ~350 | 2 |
| `lib/agentBus/store.js` | 改 | ~80 | 1 |
| `lib/agentBus/notifications.js` | 改 | ~120 | 3,5 |
| `lib/agentBus/transport.js` | 改 | ~30 | 3 |
| `routes/agents.js` | 改 | ~120 | 4,6 |
| `server.js` | 改 | ~10 | 4 |
| `claudes/全栈架构师_PM-A1/CLAUDE.md` | 改 | ~40 | 5 |
| `HR/assets/roles/pmo.md` | 新建 | ~80 | 4 |
| **合计** | | **~2130** | |

---

## 十一、自动化评估 (完成后)

### 能自动化的 (预估 80-85%)

| 场景 | 实现方式 |
|------|---------|
| 需求→代码 | PM 生成 DAG → dagEngine 分发 → agent 执行 → reviewer 审核 → 通过 |
| 质量修正 | 打回机制 → 修改建议 → 重新执行 → 再审核 |
| 调度与唤醒 | 依赖满足 → 自动激活 → SSE + PTY 送达 |
| 任务超时 | stale reclaim + DAG 超时升级 |
| 文件冲突 | fileTree 写锁 → 串行化 |
| PM 故障 | PMO 检测 → launch_agent_session → 恢复 |
| Agent 闲置管理 | PM sleep → 5min wake → PMO poll → 新任务 |
| 打回分歧 | retry_count > 3 → 自动升级给 PM |
| Agent 离线 | 自动 launch_agent_session (已有) |

### 仍需人类的 (预估 15-20%)

| 场景 | 原因 |
|------|------|
| DAG 方向错误 | PM 误解需求 → 整个 DAG 跑偏 → 人类验收时发现 |
| 架构选型 | 高风险决策 → 升级链穿透到人类 |
| 外部依赖 | 等运维/第三方——系统只能阻塞等待 |
| 验收标准本身有问题 | 标准模糊导致 reviewer 无法判断 → 需要人类澄清 |
| PMO + PM 同时故障 | 双重故障 → 需要人类重启 |

### 核心结论

**这是一个 "人在环上" (Human-on-the-Loop) 而非 "人在环中" (Human-in-the-Loop) 的系统。** 人类不需要参与每个任务的派发/执行/审核，只需要在 DAG 创建时确认方向、在异常时介入决策。一个 4-agent 团队可以以 1/5 的人类时间投入维持全速开发。

---

*规划完成。等待 PM 审核通过后开始 Phase 1 实现。*
