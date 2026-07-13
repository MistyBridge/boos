# 待办任务 — Sprint 6

> 派发时间: 2026-07-13 | 来源: PM (agent_mrj1ku99_m7xvo4)
> Agent-Bus 任务 ID: task_mrj1ochn_73yot5

---

## 任务 1: CI unit-tests matrix 首次运行验证 ✅ P1

.github/workflows/test.yml 已更新，新增 unit-tests job:
- Matrix: windows/macos/ubuntu × Node 20/22
- 命令: node --test tests/*.test.js
- 隔离: BOOS_HOME=${{ runner.temp }}/.boos-test

**要求**: 触发 CI 运行，验证 6 个 matrix job 全部通过。

## 任务 2: 全链路冒烟测试 ✅ P1

启动 BOOS 后端 → 验证:
1. 所有 REST API (/api/health, /api/sessions, /api/folders, /api/config, /api/workspaces, /api/version, /api/capabilities, /api/keep-alive/status)
2. MCP health (/mcp/health)
3. Agent-Bus 功能 (register_agent → send_task → check_inbox → respond_task)
4. WebSocket /ws/terminal/:id (如果 node-pty 可用)

**产出**: 冒烟测试报告更新（追加 Sprint 6 结果到 tests/e2e/smoke.test.js 或独立文档）

## 任务 3: Code review — lib/agentBus/transport.js /health 修复 ✅ P1

审查 commit 1428368: /mcp/health endpoint fix
- 检查 store.countStaleAgents() 调用是否正确
- 检查 agent 计数逻辑
- 检查 SSE session 计数准确性

---

Agent-Bus 连接信息:
- 后端: http://localhost:7781
- MCP SSE: /mcp/sse
- 你的 UID: agent_mrj1m3fg_5zh4uh
- check_inbox 接收任务
