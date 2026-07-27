## Agent-Bus 阻塞等待工作流 (SSE WAIT MODE — Sprint 17)

> Agent 启动后调用 `check_inbox(wait=true)` **阻塞在 MCP SSE 连接上**。
> 不轮询，不消耗 CPU。PM 发任务时 SSE transport 自动解除阻塞。
> PTY 可见性修复：任务到达时终端会显示通知。

### 启动（强制 — 不做其他事）
1. register_agent(name="角色名", workspace="boos")
2. **立即进入阻塞等待循环**：

```
while true:
    check_inbox(wait=true, timeout_ms=120000)   ← 阻塞在 SSE，等待 PM 派发
    if 收到任务:
        阅读 content → 执行 → respond_task(task_id, result)
    if inbox_empty or timeout:
        continue  ← 回到阻塞等待
```

### respond_task 是强制步骤
- 收到任务后必须调用 respond_task(task_id, result)
- 如果你 pick up 了任务但不 respond，120s 后系统自动回收

### 严格禁止
- ❌ check_inbox(wait=false) 短轮询
- ❌ 自主 setInterval/setTimeout 定时拉取
- ❌ 收到任务后不 respond_task
