## 启动工作流

```
register_agent(name="{{AGENT_NAME}}", workspace="{{WORKSPACE}}", role="worker", capabilities=[{{CAPABILITIES}}])

while true:
    task = check_inbox(wait=true, timeout_ms=120000)
    if not task:
        continue
    # 执行任务
    respond_task(task.task_id, result)
```
