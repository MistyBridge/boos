---
name: polling-agent-bus
description: Polls the agent-bus inbox for pending tasks from other agents, executes them, and responds with results. Use when connected to agent-bus MCP, when working in a multi-agent workspace, or when the user expects cross-agent task collaboration.
---

# Agent Bus 自动轮询与任务协作

## 概述

此 Skill 让 Claude 成为 agent-bus 工作区中的主动协作者。Agent 采用**事件驱动休眠模式**：非阻塞检查收件箱 → 有任务就做 → 做完立即休眠，等待其他 agent 通过 `wake_agent` 激活。

**v3.0 事件驱动休眠模式 + Auto-Wake**：`send_task` 后 BOOS **自动调用 `wake_agent`**（系统级强制执行）。Agent 收到 PTY 注入的唤醒消息时，消息中带有发送者身份标识。无需手动 `wake_agent`。

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

### 2. 收件箱检查（非阻塞，立即返回）

**每次对话开始时，在响应用户之前，先调用 `check_inbox`：**

```
check_inbox(wait=false)
```

返回结果分两种情况：

- **`inbox_empty: true`** → 无新任务，自然结束 turn（休眠），等待其他 agent 唤醒
- **`inbox_empty: false`** → 有任务，`task` 字段包含完整任务信息

**严格禁止阻塞等待**：

```
❌ check_inbox(wait=true)                     ← 禁止！阻塞等待
❌ check_inbox(wait=true, timeout_ms=120000)  ← 禁止！超长时间等待
✅ check_inbox(wait=false)                    ← 正确！立即返回
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

5. **回到步骤 2** — 再次 `check_inbox(wait=false)` 检查是否有更多任务
6. 如果收件箱为空 → **休眠**（输出状态信息，结束当前 turn）

### 4. 休眠与唤醒机制

```
你的工作循环：
  check_inbox(wait=false)
  ├─ 有任务 → 执行 → respond_task → 回到 check_inbox(wait=false)
  └─ 无任务 → 输出 "队列为空，进入休眠" → 自然结束 turn

PM 或其他 agent 唤醒你：
  send_task(to_uid=你的UID, content="...")
  → wake_agent(target_uid=你的UID)
  → BOOS 向你的终端注入 "check_inbox(wait=false)"
  → 你收到新消息 → check_inbox(wait=false) → 发现任务 → 执行
```

### 5. 请求-响应协议 (Sprint 19)

所有消息分为两类，**请求必须回复，禁止静默完成**：

```
请求消息 (message_type="request", 默认):
  send_task(to_uid="<目标>", content="请完成X任务")
  → 对方必须发送返回消息后才能 respond_task

返回消息 (message_type="response"):
  send_task(to_uid="<目标>", content="X任务已完成",
            message_type="response", reply_to="<原请求task_id>")
  → 可以不回复（链终止于原始请求方）
  → 也可以继续回复，但最终必须终止于原始请求方
```

**完整流程示例**：
```
PM → 前端: send_task(content="修bug", message_type="request")
前端: check_inbox → 收到请求 → 修bug
前端 → PM: send_task(content="bug修好了", message_type="response", reply_to="task_xxx")
前端: respond_task(task_id="task_xxx", result="完成")  ← 必须先发返回消息
```

**协议规则（系统强制）**：
- `respond_task` 对 `request` 类型任务：必须先 `send_task(message_type="response")` 回复发送方
- `response` 必须带 `reply_to` 指向被回复的任务
- 消息链必须终止于最初的请求方或接收方

### 6. 主动发送任务

```
# 先查看谁在线
list_agents()

# 发送请求（BOOS 自动唤醒目标 agent）
send_task(to_uid="<目标uid>", content="<任务描述>", priority="normal")
# message_type 默认为 "request" — 对方必须回复
```

### 7. 广播

需要通知工作区所有成员时：

```
broadcast(message="<公告内容>")
```

## 完整的对话轮次模式

```
启动/被唤醒：
  1. check_inbox(wait=false)           ← 非阻塞检查
  2. 有任务 → 执行 → respond_task → 回到步骤 1
  3. 无任务 → 输出休眠状态 → 结束 turn

发送任务给其他 agent：
  1. send_task(to=agent_B, ...)        ← 向其他 agent 发送任务
  2. wake_agent(target_uid=agent_B)    ← 必须唤醒对方！
  3. 回复用户当前状态
```

## 通知机制

agent-bus v3.0 事件驱动架构：

```
Agent A (PM): send_task → wake_agent
                              ├─ SSE 通知 → Agent B 的 MCP 连接
                              └─ PTY 注入 → Agent B 终端收到 check_inbox(wait=false)
                                                          ↓
                                              Agent B: check_inbox(wait=false)
                                                       → 发现任务 → 执行 → respond_task
                                                       → 再次 check_inbox(wait=false)
                                                       → 空 → 休眠
```

**关键点**：
- `send_task` 只是把任务放入队列，**不会自动唤醒目标 agent**
- 发任务后**必须调用 `wake_agent`** 才能真正激活休眠中的 agent
- SSE 通知 + PTY 注入双通道同时触发，确保 agent 能收到唤醒信号
- Agent 被唤醒后非阻塞检查收件箱，处理完所有任务后再次休眠

## 注意事项

- 每次被唤醒后处理收件箱中所有任务，直到空为止
- `check_inbox` 会将任务状态从 `pending` 变为 `in_progress`（FIFO 取走）
- 任务完成后务必 `respond_task`，否则任务永远卡在 `in_progress`
- 如果任务执行中被打断，sender 可调用 `interrupt_task`
- 用 `list_my_tasks` 查看自己的所有收发任务历史
- 用 `get_task(task_id)` 查询任意任务的当前状态
- **禁止** `check_inbox(wait=true)` 或任何形式的阻塞等待
- **禁止** `while true` 无限循环轮询
- **禁止** `setInterval` / `setTimeout` 自主定时拉取

## 参考

详细的工具参数和返回格式见 [agent-bus 工具参考](references/agent-bus-tools.md)。
