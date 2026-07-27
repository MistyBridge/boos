---
name: sprint-7-agent-bus-config
description: Sprint 7 部署配置 — BOOS 内嵌 agent-bus port 7784, auto-deliver tasks
metadata:
  type: reference
---

## Sprint 7 (2026-07-14) Agent-Bus 变更

- **BOOS 内嵌 agent-bus**: `http://127.0.0.1:7784/mcp/sse`（不再使用独立 agent-bus 服务）
- **BOOS backend**: port 7784, PID 9688
- **#51 生命周期管理修复**: heartbeat watchdog 修复 + 跨进程文件锁 — `webTerminal.js`, `persistedSessions.js`
- **#52 通知自动化**: agent-bus auto-deliver 任务，任务内容直接推送到终端，无需手动 check_inbox
- 每个角色需重启 Claude Code 让新 `.mcp.json` 生效
