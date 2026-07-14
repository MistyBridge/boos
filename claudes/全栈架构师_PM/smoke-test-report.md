# Smoke Test Report — v1.0.1

> Date: 2026-07-14 | Tester: PM via agent-bus | Target: http://127.0.0.1:7780

## API Endpoint Tests (9/9 PASS ✅)

| # | Endpoint | Method | Result | Detail |
|---|----------|--------|--------|--------|
| 1 | /api/health | GET | PASS | v1.0.0, pid 31600 |
| 2 | /api/sessions | GET | PASS | 2 sessions |
| 3 | /api/config | GET | PASS | port=7780, 3 CLIs |
| 4 | /api/version | GET | PASS | v1.0.0 |
| 5 | /api/folders | GET | PASS | folders accessible |
| 6 | /api/capabilities | GET | PASS | webTerminal=true |
| 7 | /api/workspaces | GET | PASS | workspaces list ok |
| 8 | /mcp/health | GET | PASS | 4 active SSE, 3 agents |
| 9 | /api/heartbeat | POST | PASS | {"ok":true} |

## Agent-Bus Connectivity

- 4 agents active in workspace "boos"
- 21 MCP tools (incl. wake_agent after restart)
- SSE transport: 4 active sessions
- Task queue: 17 tasks, no orphaned
- Store integrity: ~/.boos/agent-bus-store.json intact

## Pending for Restart

- TTL disabled (transport.js + registry.js)
- wake_agent MCP tool deployment
- BOOS Muted Dark palette activation
- Xterm glyph atlas refresh (30s periodic cleanup)

## Summary

**9/9 endpoints pass.** Backend is stable. New features (Sprint 6)
require BOOS restart to take effect in production.
