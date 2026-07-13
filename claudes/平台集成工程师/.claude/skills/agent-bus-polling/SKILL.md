---
name: polling-agent-bus
description: Polls the agent-bus inbox for pending tasks from other agents, executes them, and responds with results. Use when connected to agent-bus MCP, when working in a multi-agent workspace, or when the user expects cross-agent task collaboration.
---

# Agent Bus 自动轮询与任务协作

## 概述

此 Skill 让 Claude 成为 agent-bus 工作区中的主动协作者。Claude 不应被动等待任务 — 它应在每次对话机会时主动检查收件箱，拉取并执行其他 agent 发送的任务。

**v2.1 推送通知**：agent-bus server 现在支持任务推送。当其他 agent 向你发送任务且你的收件箱之前为空时，server 会通过 SSE 主动推送通知。如果你正在使用 `check_inbox(wait: true)` 阻塞等待，任务会立即返回，零轮询延迟。

## 工作流程

### 1. 启动注册

当 agent-bus MCP 可用时，首次对话调用 `register_agent`：

```
register_agent(name="<角色名>", intro="<一句话职责>", workspace="<工作区名>")
```

- `name`: 人类可读的角色名，如"前端开发工程师"
- `intro`: 简短描述，让其他 agent 知道何时向你发送任务
- `workspace`: 所属工作区名（从 cwd 推断，如 `quant-dashboard`）

注册成功后会返回 `uid`。**重点**：`name + workspace` 是你的永久身份，即使 server 重启、session 断开重连，你都会拿回同样的 `uid` 和待处理任务。响应会包含：

- `reconnected: true/false` — 是否重连
- `pending_tasks: N` — 断线期间积压的任务数
- `hint` — 提示下一步操作

### 2. 收件箱检查（支持阻塞等待）

**每次对话开始时，在响应用户之前，先调用 `check_inbox`：**

```
check_inbox()
```

返回结果分两种情况：

- **`inbox_empty: true`** → 无新任务，正常响应用户
- **`inbox_empty: false`** → 有任务，`task` 字段包含完整任务信息

**推送通知模式（推荐）**：如果你想等待任务而不是立即返回空结果，使用阻塞模式：

```
check_inbox(wait: true, timeout_ms: 30000)
```

- Server 会挂起响应直到有任务到达或超时
- 当其他 agent 调用 `send_task` 向你发送任务时，server 立即通过 SSE 推送通知，你的 `check_inbox` 调用会立刻返回任务
- 超时后返回 `{ inbox_empty: true, waited_ms: 30000 }`，你可以再次调用
- 这消除了轮询开销：不需要反复调用 `check_inbox` 直到有结果

**注意**：`wait` 模式让 Claude 的 tool call 保持 pending 状态，在此期间 Claude 不能处理其他 tool call。仅在预期很快会有任务时使用（如等待协作 agent 的响应）。日常检查使用无参 `check_inbox()`。

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

# 发送任务（FIFO 排队）
send_task(to_uid="<目标uid>", content="<自然语言任务描述>", priority="normal")
```

### 5. 广播

需要通知工作区所有成员时：

```
broadcast(message="<公告内容>")
```

## 完整的对话轮次模式

```
用户消息 →
  1. check_inbox()                    ← 先检查是否有新任务（即时）
  2. 如有任务 → 执行 → respond_task()
  3. 如无任务 → 正常回复用户消息

等待协作响应模式：
  1. send_task(to=agent_B, ...)       ← 向其他 agent 发送任务
  2. 回复用户当前状态
  3. 下次对话时 → check_inbox()       ← 检查是否有 agent_B 的响应
  4. 或使用 check_inbox(wait:true, timeout_ms:60000) ← 阻塞等待响应
```

## 通知机制

agent-bus v2.1 的推送通知架构：

```
Agent A: send_task → queue.js → insertTask()
                                    ↓
                           inbox 0→1? → emit('task_available', uid_B)
                                    ↓
                           bridge.js (SSE) → notifyAgent(uid_B)
                                    ↓
                           ┌────────┴────────┐
                           ↓                  ↓
              check_inbox(wait:true)    SSE notification
              立即 resolve 返回任务      (Claude Code 未来可响应)
```

**关键点**：
- 推送只在收件箱从空的变成有任务时（0→1）触发，避免重复通知
- 如果 agent 正在 `check_inbox(wait: true)` 中等待，通知会立即 resolve Promise，任务近实时返回
- 如果 agent 没有在等待，SSE 通知作为提示信息推送，agent 下次调用 `check_inbox()` 时任务立即可用
- 多个任务同时到达只触发一次通知（0→1），agent 通过 `check_inbox` 逐个取出

## 注意事项

- 每次对话只检查一次收件箱（在对话开始时）
- `check_inbox` 会将任务状态从 `pending` 变为 `in_progress`（FIFO 取走）
- 任务完成后务必 `respond_task`，否则任务永远卡在 `in_progress`
- 如果任务执行中被打断，sender 可调用 `interrupt_task`
- 用 `list_my_tasks` 查看自己的所有收发任务历史
- 用 `get_task(task_id)` 查询任意任务的当前状态

## 参考

详细的工具参数和返回格式见 [agent-bus 工具参考](references/agent-bus-tools.md)。
