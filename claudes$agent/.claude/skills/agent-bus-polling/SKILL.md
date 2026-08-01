---
name: agent-bus-collaboration
description: Event-driven agent-bus task collaboration. Use when connected to agent-bus MCP, when working in a multi-agent workspace, or when the user expects cross-agent task collaboration.
---

# Agent Bus 事件驱动协作 (v3.0)

## 概述

此 Skill 让 Claude 成为 agent-bus 工作区中的事件驱动协作者。**不再轮询** —
BOOS 代码层通过 SSE 推送 + PTY 注入 + auto-wake 主动通知 agent，agent 收到
唤醒后调用 `check_inbox()`（非阻塞）拉取任务。

**v3.0 事件驱动** (Sprint 21+): 废除所有轮询。`check_inbox` 不再接受 `wait` /
`timeout_ms` 参数。Agent 只响应事件，不主动拉取。

## 工作流程

### 1. 启动注册

当 agent-bus MCP 可用时，首次对话调用 `register_agent`：

```
register_agent(name="<角色名>", intro="<一句话职责>", workspace="<工作区名>", cli_session_id="<UUID>")
```

- `name`: 人类可读的角色名，如"前端开发工程师"
- `intro`: 简短描述，让其他 agent 知道何时向你发送任务
- `workspace`: 所属工作区名
- `cli_session_id`: 你的 Claude `--resume` UUID（即你的 agent UID）

注册成功后会返回 `uid`。`cli_session_id` 是你的永久身份，即使 server 重启、
session 断开重连，你都会拿回同样的 `uid` 和待处理任务。

### 2. 事件驱动收件箱（零轮询）

**不主动轮询**。工作模式：

1. 启动时调用 `register_agent` → 重连时自动拿到积压任务数
2. 启动时调用一次 `check_inbox()` → 如果有任务就处理
3. 进入休眠等待态 → 其他 agent 通过 `send_task` 发任务时：
   - BOOS 自动调用 `wake_agent` 唤醒你
   - SSE 推送通知到你的 MCP 连接
   - PTY 注入 `check_inbox` 命令到你的终端
4. 被唤醒后 → 调用 `check_inbox()` → 拉取并处理任务

```
Agent A: send_task(to=agent_B)
  → BOOS 代码层: auto-wake + SSE 推送 + PTY 注入
  → Agent B 被唤醒 → check_inbox() → 拉取任务 → 执行 → respond_task()
```

### 3. 任务执行

收到任务后，根据 `task.content`（自然语言指令）执行工作：

1. 阅读 `task.sender` 了解谁发送的（含 name + intro）
2. 阅读 `task.content` 理解任务要求
3. 使用你的工具和技能完成任务
4. 完成后调用 `respond_task`：

```
respond_task(task_id="<task.task_id>", result="<执行结果摘要>")
```

### 4. 主动发送任务

当你需要其他 agent 协助时：

```
# 先查看谁在线
list_agents()

# 发送任务（FIFO 排队，auto-wake 自动唤醒接收方）
send_task(to_uid="<目标uid>", content="<自然语言任务描述>", priority="normal")
```

`send_task` 成功后 BOOS 自动调用 `wake_agent`，无需手动唤醒。

### 5. 广播

需要通知工作区所有成员时：

```
broadcast(message="<公告内容>")
# 或唤醒所有 agent
wake_all(message="<紧急通知>")
```

## 完整的事件驱动模式

```
启动 →
  1. register_agent(...)                ← 注册/重连
  2. check_inbox()                      ← 拉取积压任务（如有）
  3. 如无任务 → 进入休眠等待态

被 wake_agent 唤醒 →
  1. check_inbox()                      ← 拉取新任务
  2. 执行任务 → respond_task(task_id, result)
  3. 完成后 → wake_agent(PM_uid)        ← 通知 PM
  4. 回到休眠等待态
```

## 通知架构 (v3.0)

```
Agent A: send_task(to=uid_B)
  → queue.js → inboxStore.addPending()
  → inboxEvents.emit('task_available', uid_B)
  → notifications.js:
      ├─ SSE push: 事件推送到 agent 的 MCP 连接
      ├─ auto-wake: 调用 wake_agent(target_uid=uid_B)
      └─ PTY 注入: 终端注入 check_inbox 命令
  → Agent B 被唤醒 → check_inbox() → 拉取任务
```

## 严格禁止

- ❌ `check_inbox(wait=true)` — 阻塞等待已废除 (Sprint 21)
- ❌ `setInterval` / `setTimeout` 定时拉取
- ❌ `check_decisions` / `check_root_response` — 已移除
- ❌ 任何形式的轮询 loop

## 注意事项

- `check_inbox` 会将任务状态从 `pending` 变为 `in_progress`（FIFO 取走）
- 任务完成后务必 `respond_task`，否则任务永远卡在 `in_progress`
- 如果任务执行中被打断，sender 可调用 `interrupt_task`
- 用 `list_my_tasks` 查看自己的所有收发任务历史
- 用 `get_task(task_id)` 查询任意任务的当前状态

## 参考

详细的工具参数和返回格式见 [agent-bus 工具参考](references/agent-bus-tools.md)。
