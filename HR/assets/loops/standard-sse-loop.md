# Standard SSE Loop

适用于大多数 worker agent 的标准 SSE 阻塞循环。

```markdown
## 启动工作流

register_agent(name="{{AGENT_NAME}}", workspace="{{WORKSPACE}}", role="worker", capabilities=[{{CAPABILITIES}}])

while true:
    task = check_inbox(wait=true, timeout_ms=120000)
    if not task:
        continue

    # 解析任务类型
    # 执行任务逻辑
    # respond_task(task.task_id, result)
```

**关键点**:
- `wait=true` 阻塞等待，零轮询开销
- `timeout_ms=120000` (2分钟)，超时后自动重连
- 完成任务后必须 `respond_task`
- 禁止轮询 `list_my_tasks`
- 禁止手动 PTY `\r` 注入
