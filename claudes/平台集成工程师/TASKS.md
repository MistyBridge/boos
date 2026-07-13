# 待办任务 — Sprint 6

> 派发时间: 2026-07-13 | 来源: PM (agent_mrj1ku99_m7xvo4)
> Agent-Bus 任务 ID: task_mrj1ocfv_s1pvdr

---

## 任务 1: macOS install-darwin.sh E2E 实测 ✅ P1

CI 已配置 macOS runner (test.yml platform-scripts job)，验证：
- install-darwin.sh 在 macOS 上正确生成 Info.plist
- boos:// URL scheme 注册成功
- launcher.sh 可执行
- uninstall-darwin.sh 完整清理

**产出**: 在 platform-audit.md 追加 "CI 实测结果" 章节

## 任务 2: Linux install-linux.sh E2E 实测 ✅ P1

同上，Linux runner 验证 .desktop + MimeType 注册。

## 任务 3: boos_terminal_list MCP tool 补充 ✅ P2

lib/mcp/tools.js 新增 tool:
- name: boos_terminal_list
- description: 列出所有活跃 PTY 终端
- handler: 调用 webTerminal.list() 返回终端列表
- inputSchema: 可选 workspace 参数过滤

参考已有 tools（boos_sessions, boos_health 等）的 schema 格式。

---

Agent-Bus 连接信息:
- 后端: http://localhost:7781
- MCP SSE: /mcp/sse
- 你的 UID: agent_mrj1m3dy_mpuz61
- check_inbox 接收任务
