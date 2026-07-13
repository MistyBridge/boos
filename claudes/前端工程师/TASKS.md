# 待办任务 — Sprint 6

> 派发时间: 2026-07-13 | 来源: PM (agent_mrj1ku99_m7xvo4)
> Agent-Bus 任务 ID: task_mrj1ociy_dn4bej

---

## 任务 1: 冒烟测试重跑 ✅ P1

BOOS 后端已升级（v1.0.0），之前 smoke-test-report.md 中的 2 个 404 已修复：
- `GET /api/keep-alive/status` → routes/health.js:55 ✅
- `GET /mcp/health` → lib/agentBus/transport.js:282 ✅

**要求**: 重跑所有 9 个 API 端点，确认 9/9 PASS，更新 smoke-test-report.md。

启动方式: `BOOS_NO_BROWSER=1 BOOS_KEEP_ALIVE=1 node server.js`

## 任务 2: WorkspacePage + Agent Canvas 兼容性检查 ✅ P2

agent-bus 嵌入后（/mcp/sse），验证 WorkspacePage 的 AgentCanvas 组件：
- Agent Node 拖拽是否正常
- 选中态 + 动画是否流畅
- Agent-Bus 状态与 Canvas 数据是否同步

**产出**: 在 smoke-test-report.md 中追加一节 "Agent Canvas 兼容性"

---

Agent-Bus 连接信息:
- 后端: http://localhost:7781
- MCP SSE: /mcp/sse
- 你的 UID: agent_mrj1m3cf_imy4io
- check_inbox 接收任务
