## 启动工作流 (Event-Driven Mode — Sprint 19)

```
1. register_agent(name="{{AGENT_NAME}}", workspace="{{WORKSPACE}}", role="worker", capabilities=[{{CAPABILITIES}}])
2. check_inbox(wait=false)   ← 非阻塞检查，立即返回
3. 有任务 → 执行 → respond_task(task.task_id, result) → 回到步骤 2
4. 无任务 → 休眠（等待 PM 或其他 agent 的 wake_agent 激活）
```
