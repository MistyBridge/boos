# Standard Event-Driven Loop (Sprint 21 — 纯事件驱动，零轮询)

适用于大多数 worker agent 的标准事件驱动循环。

```markdown
## 启动工作流

1. register_agent(name="{{AGENT_NAME}}", workspace="{{WORKSPACE}}", role="worker", capabilities=[{{CAPABILITIES}}])
2. check_inbox   ← 立即返回，事件驱动
3. 有任务 → 执行 → respond_task(task.task_id, result) → 回到步骤 2
4. 无任务 → 休眠（等待 PM 或其他 agent 的 wake_agent 激活）
```

**关键点**:
- check_inbox 立即返回 — 不阻塞，不等待
- 有任务就做，做完继续检查，直到收件箱为空
- 空则休眠 — 不轮询、不长时间等待、不消耗 CPU
- PM 发任务后通过 `wake_agent` 激活休眠 agent (SSE 通知 + PTY 注入)
- 被唤醒后重新 `check_inbox` 检查收件箱
- 完成任务后必须 `respond_task`
- 决策结果和 Root 响应通过 SSE 推送，无需轮询 `check_decisions` 或 `check_root_response`
- **禁止** `while true` 无限循环
- **禁止** 任何形式的轮询/阻塞等待
