# Agent-Bus & BOOS 全量函数分析报告

> 日期: 2026-08-02 | 总工具数: 51 | Sprint 36

---

## 一、权限分级

### 🔓 零权限 (无认证即可调用, 2 tools)

| 工具 | 风险 |
|------|------|
| `register_agent` | 设计如此 — 这是认证入口 |
| `get_task` | ⚠️ **Bug**: handler 无 ctx.uid 检查，任何人可查任意 task_id |
| `boos_terminal_list` | ⚠️ **设计如此**: handler 明确忽略 ctx，暴露所有 PTY/PID/CWD |

### 🔵 Worker 级 (注册即可, 25 tools)

`deregister_agent`, `list_agents`, `send_task`, `check_inbox`, `respond_task`, `retry_task`, `list_my_tasks`, `broadcast`, `wake_agent`, `wake_all`, `dag_status`, `dag_my_tasks`, `dag_list`, `dag_submit_task`, `dag_approve_task`, `dag_reject_task`, `dag_wake_agent`, `request_decision`, `send_to_root`, `request_file_lock`, `release_file_lock`, `list_file_locks`, `update_knowledge`, `query_knowledge`, `constraints_check`, `constraints_status`, `boos.list_sessions`, `boos.get_session`, `boos.list_workspaces`

### 🟡 Supervisor 级 (需 supervisor role, 12 tools)

`set_pm`, `assign_to_project`, `list_agent_cards`, `team_matrix`, `kill_worker`, `assign_task`, `list_all_agents`, `define_workflow`, `add_stage`, `add_dependency`, `activate_workflow`, `dag_sleep_agent` (PM cannot sleep another supervisor)

### 🟠 PM/PMO 级 (需 supervisor 或 pmo role, 5 tools)

`dag_create`, `dag_add_task`, `dag_activate`, `dag_cancel`, `dag_reassign_task`

### 🔴 特殊 RBAC

| 工具 | 限制 |
|------|------|
| `cancel_task` | 仅 sender 或 supervisor |
| `interrupt_task` | 仅 sender 或 supervisor |
| `respond_task` | 仅 receiver (queue 层验证) |
| `release_file_lock` | 仅 lock holder 或 supervisor |
| `dag_submit_task` | 仅 executor |
| `dag_approve_task` | 仅 reviewer |
| `dag_reject_task` | 仅 reviewer |

---

## 二、延迟分级

### INSTANT (<1ms, 纯内存/同步, 6 tools)

| 工具 | 操作 |
|------|------|
| `retry_task` | sync queue 操作 |
| `get_task` | sync 内存查任务 |
| `dag_status` | sync 读 DAG |
| `dag_my_tasks` | sync 内存过滤 |
| `release_file_lock` | sync 内存释放 |
| `list_file_locks` | sync 内存读 |
| `constraints_check` | sync 内存约束检查 |
| `constraints_status` | sync 内存聚合 |

### FAST (<50ms, 内存/JSON 读写, 14 tools)

| 工具 | 主要 I/O |
|------|----------|
| `deregister_agent` | registry 操作 |
| `list_agents` | 内存遍历 |
| `set_pm` | store 写入 |
| `assign_to_project` | store 写入 |
| `list_all_agents` | store 读取 |
| `dag_create` | dagStore 写入 |
| `dag_add_task` | dagStore 写入 |
| `dag_cancel` | 批量 status 更新 |
| `dag_submit_task` | taskSystem 写入 |
| `dag_reject_task` | taskSystem 写入 |
| `dag_reassign_task` | taskSystem 写入 |
| `dag_list` | dagStore 读取 |
| `define_workflow` | workflowEngine 创建 |
| `add_stage` | workflowEngine 写入 |
| `add_dependency` | workflowEngine 写入 |
| `request_decision` | 文件写入 |
| `request_file_lock` | 内存锁获取 |

### MODERATE (<500ms, 文件锁/PTY/SSE, 18 tools)

| 工具 | 主要 I/O |
|------|----------|
| `register_agent` | 多 store 写入 + PG upsert + PTY 注入 |
| `send_task` | 文件锁队列写入 + SSE + PTY |
| `check_inbox` | 文件锁出队 |
| `cancel_task` | 文件锁状态变更 |
| `interrupt_task` | 文件锁状态变更 + 事件发射 |
| `respond_task` | 文件锁写入结果 |
| `list_my_tasks` | 文件读取 |
| `wake_agent` | SSE 推送 + PTY 注入 |
| `dag_activate` | 批量激活 + 通知 |
| `dag_approve_task` | 审批 + 级联解锁 + 通知 |
| `dag_sleep_agent` | PTY /compact 注入 |
| `dag_wake_agent` | PTY check_inbox 注入 |
| `activate_workflow` | 派发 N 个任务 |
| `send_to_root` | 文件锁写队列 |
| `kill_worker` | 级联任务取消 |
| `update_knowledge` | 磁盘写入 |
| `query_knowledge` | 磁盘搜索 |
| `boos_terminal_list` | PTY 池枚举 + 磁盘读 |
| `boos.list_sessions` | 磁盘读 |
| `boos.get_session` | 磁盘读 + PTY 状态 |

### SLOW (<5s, 全量扫描/批量操作, 5 tools)

| 工具 | 耗时原因 |
|------|----------|
| `broadcast` | 对 N 个 agent 串行 send_task + wake |
| `list_agent_cards` | 每 agent: identityResolver + dagStore + PTY 探测 |
| `team_matrix` | 全 workspace 扫描 + DAG 交叉引用 |
| `wake_all` | 串行 SSE + PTY 注入 N 个 agent |
| `boos.list_workspaces` | 文件系统目录枚举 + repo 状态 |

---

## 三、副作用分级

### 📖 纯读 (无副作用, 16 tools)

`list_agents`, `get_task`, `list_my_tasks`, `dag_status`, `dag_my_tasks`, `dag_list`, `list_all_agents`, `list_agent_cards`, `team_matrix`, `list_file_locks`, `query_knowledge`, `constraints_check`, `constraints_status`, `boos_terminal_list`, `boos.list_sessions`, `boos.get_session`, `boos.list_workspaces`

### ✏️ 写入本地 (磁盘/内存变更, 20 tools)

`deregister_agent`, `retry_task`, `cancel_task`, `respond_task`, `set_pm`, `assign_to_project`, `kill_worker`, `assign_task`, `dag_create`, `dag_add_task`, `dag_cancel`, `dag_submit_task`, `dag_reject_task`, `dag_reassign_task`, `define_workflow`, `add_stage`, `add_dependency`, `request_decision`, `request_file_lock`, `release_file_lock`, `update_knowledge`

### 📡 网络推送 (SSE/PTY 注入, 13 tools)

| 工具 | 推送内容 |
|------|----------|
| `register_agent` | 重连时 auto-wake + PTY 注入 |
| `send_task` | SSE + PTY 唤醒接收方 |
| `check_inbox` | 任务领取事件 |
| `interrupt_task` | 中断通知接收方 |
| `broadcast` | SSE + PTY 唤醒全 workspace |
| `wake_agent` | SSE + PTY 注入目标 agent |
| `wake_all` | SSE + PTY 注入全部 agent |
| `dag_activate` | 通知 executor |
| `dag_approve_task` | 通知下游 executor |
| `dag_sleep_agent` | PTY 注入 /compact |
| `dag_wake_agent` | PTY 注入 check_inbox |
| `activate_workflow` | 通知所有 stage executor |
| `send_to_root` | SSE 推送到 Root UI |

---

## 四、关键发现

### ⚠️ 安全问题

| # | 问题 | 严重度 |
|---|------|:------:|
| 1 | `get_task` 零认证 — 任何人可查任意 task_id | 🔴 HIGH |
| 2 | `boos_terminal_list` 零认证 — 暴露所有 PTY/PID/CWD | 🟡 MEDIUM |
| 3 | `broadcast` 速率限制在内存中 — 重启丢失 | 🟡 LOW |

### 📊 统计

| 维度 | 数据 |
|------|------|
| 总工具数 | 51 |
| 需 supervisor+ 权限 | 17 (33%) |
| 零权限可调用 | 3 (6%)，其中 2 个可能是 bug |
| 纯读无副作用 | 17 (33%) |
| 会产生 SSE/PTY 推送 | 13 (25%) |
| 最慢工具 | `broadcast`, `wake_all`, `list_agent_cards`, `team_matrix`, `boos.list_workspaces` |
| 最快工具 | `retry_task`, `get_task`, `dag_status`, `dag_my_tasks`, constraints 系列 |

### 🔄 通信闭环

```
PM/A3 通讯测试验证:
  send_task → inboxStore.addPending() → SSE push + PTY inject
  → agent check_inbox() → 执行 → respond_task/send_task
  → outboxEvents → 回执
  实测延迟: ~26s (含 agent 处理时间)
```
