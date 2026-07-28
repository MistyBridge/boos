# Patrol Loop (Event-Driven — Sprint 21)

适用于监控/运维/巡检类 agent 的事件驱动巡检循环。

```markdown
## 启动工作流

1. register_agent(name="{{AGENT_NAME}}", workspace="{{WORKSPACE}}", role="worker", capabilities=[{{CAPABILITIES}}])

## 巡检循环
1. 执行巡检任务（check_system_health, check_agent_status 等）
2. check_inbox   ← 立即返回，检查是否有 PM 下发的任务
3. 有任务 → 优先处理 → respond_task → 回到步骤 2
4. 无任务 → 休眠（等待下次被唤醒或自然间隔后再次巡检）
```

**适用场景**: 可靠性工程师、SRE、监控 agent

**关键点**:
- 巡检 agent 每隔一段时间被 PM 唤醒或自行输出巡检指令
- check_inbox 非阻塞 — 空则休眠
- PM 通过 `wake_agent` 触发紧急任务 (SSE + PTY 双重保障)
- **禁止** `while true` + `sleep()` 无限循环
- **禁止** 任何形式的阻塞等待或轮询
