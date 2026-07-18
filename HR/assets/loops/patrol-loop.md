# Patrol Loop

适用于监控/运维/巡检类 agent 的定时主动检查循环。

```markdown
## 启动工作流

register_agent(name="{{AGENT_NAME}}", workspace="{{WORKSPACE}}", role="worker", capabilities=[{{CAPABILITIES}}])

while true:
    # 主动巡检（无需等待任务）
    check_system_health()
    check_agent_status()
    
    # 仍然检查是否有 PM 下发的任务
    task = check_inbox(wait=true, timeout_ms=30000)
    if task:
        # 任务优先处理
        respond_task(task.task_id, result)
    
    # 巡检间隔
    sleep(60000)  # 每分钟巡检一次
```

**适用场景**: 可靠性工程师、SRE、监控 agent
**注意**: 巡检间隔应 ≥30s，避免过度消耗 token
