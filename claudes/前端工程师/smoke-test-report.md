# API 冒烟测试报告 — 路由重构验证

**日期**: 2026-07-13  
**测试人**: 前端工程师 (agent_mrirhvs3_aywg9g)  
**后端版本**: 0.22.16 (@bakapiano/ccsm)  

## 测试结果

| # | 端点 | 状态码 | 结果 |
|---|------|--------|------|
| 1 | `GET /api/health` | 200 | ✅ PASS |
| 2 | `GET /api/sessions` | 200 | ✅ PASS |
| 3 | `GET /api/folders` | 200 | ✅ PASS |
| 4 | `GET /api/config` | 200 | ✅ PASS |
| 5 | `GET /api/workspaces` | 200 | ✅ PASS |
| 6 | `GET /api/keep-alive/status` | 404 | ❌ FAIL — 端点未实现 |
| 7 | `GET /api/version` | 200 | ✅ PASS |
| 8 | `GET /api/capabilities` | 200 | ✅ PASS |
| 9 | `GET /mcp/health` | 404 | ❌ FAIL — 端点未实现 |

**通过率**: 7/9 (77.8%)

## 详情

### ✅ 通过的端点

- **`/api/health`** → `{"ok":true,"pid":24572,"version":"0.22.16","name":"@bakapiano/ccsm"}`
- **`/api/version`** → `{"current":"0.22.16","latest":"0.22.18","updateAvailable":true,"fetchedAt":...,"cached":true,"devMode":false}`
- **`/api/capabilities`** → `{"webTerminal":true,"webTerminalError":null}`
- **`/api/sessions`**, **`/api/folders`**, **`/api/config`**, **`/api/workspaces`** → 均返回 200

### ❌ 失败的端点

| 端点 | 状态码 | 原因 |
|------|--------|------|
| `/api/keep-alive/status` | 404 | 后端尚未实现该路由（Sprint 3 规划中） |
| `/mcp/health` | 404 | agent-bus MCP 健康端点未在 `/mcp/health` 暴露 |

## 结论

路由重构后核心 API（health, sessions, folders, config, workspaces, version, capabilities）全部正常工作。两个 404 端点属于后续 Sprint 规划功能，非本次重构引入的回归。
