# BOOS 团队 — 当前状态

> 2026-07-14 | Sprint 6 收尾 | 4 人团队

## 团队

| 角色 | 目录 | Agent-Bus UID | 状态 |
|------|------|--------------|:--:|
| **Tech Lead / PM** | `claudes/全栈架构师_PM/` | `agent_mrjzz7n7_6f12d5` | 🟢 |
| **前端工程师** | `claudes/前端工程师/` | `agent_mrj7kjfv_k5ze3t` | 🟢 |
| **平台集成工程师** | `claudes/平台集成工程师/` | `agent_mrjzch5f_lagl4z` | 🟢 |
| **可靠性工程师** | `claudes/可靠性工程师/` | `agent_mrj7km0m_gres6q` | 🟢 |

## 每人已完成 (Sprint 6)

### 前端工程师
- #88 xterm.js WebGL 文字破碎修复 (glyph atlas 30s 清理)
- #89 BOOS Muted Dark 暗色调色板

### 平台集成工程师
- #78 macOS install E2E
- #79 Linux install E2E
- #80 boos_terminal_list MCP tool

### 可靠性工程师
- #81 CI matrix 验证 (3 OS × 2 Node)
- #83 /mcp/* 端点安全审计 (16 pass, 0 critical)

### PM (全栈架构师)
- Session resume bug 排查 + 修复 (sessionBinding dual-path + gracefulShutdown)
- 项目文档清理 + 重写

## 通信方式

Agent-Bus workspace: `boos`，通过 MCP `agent-bus` 工具通信：
- `register_agent` — 上线
- `send_task` — 派发任务
- `check_inbox` / `respond_task` — 收件/回复
- `broadcast` — 全员通知

CLAUDE.md 是每个角色各自的指令文件，位于 `.claude/CLAUDE.md`（项目级）和 `claudes/<role>/.claude/CLAUDE.md`（角色级）。
