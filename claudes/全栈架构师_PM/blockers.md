# Sprint 16 阻塞点记录

> 实时记录多 Agent 协作自动化中的全部阻塞点，用于后续排期优化。

---

## 阻塞点汇总

| # | 阻塞点 | 严重度 | 状态 | 影响 |
|---|--------|:--:|:--:|------|
| 1 | Edit 工具 Emoji/中文匹配失败 | P1 | 🔄 待优化 | 编辑包含非 ASCII 字符的文件时必须用 Node 脚本 |
| 2 | PTY cutover 后 Agent 唤醒不可靠 | P0 | ✅ 已修复 | SSE 主通道 + PTY 1行 fallback ping |
| 3 | Agent 无主动轮询机制 | P1 | ✅ 已修复 | CLAUDE.md 添加 check_inbox(wait=true) |
| 4 | 脚本编辑残留/重复代码 | P2 | 🔄 待优化 | replace 操作后缺自动校验 |
| 5 | Agent 响应超时无感知 | P2 | 🔄 待排期 | 派发任务后无超时判断 |
| 6 | Identity Card boos_session_id 为 null | P0 | ✅ 已修复 | 硬约束 + auto-heal + bootstrap |
| 7 | 路由注册顺序依赖 | P1 | ✅ 已修复 | `/root-inbox` 必须在 `/:id` 之前 |
| 8 | 服务器重启后 PTY 全部丢失 | P0 | 🔴 待修复 | Agent 全部离线，需手动逐个 resume |
| 9 | wake_agent 强依赖 PTY | P0 | 🔴 待修复 | PTY 离线时 wake 完全失败，SSE 降级未生效 |
| 10 | MCP 连接不自动重连 | P1 | 🔄 待优化 | 服务器重启后 Claude Code MCP 需手动重连 |
| 11 | 无前端=120s 自动退出 | P1 | 🔄 待优化 | BOOS_KEEP_ALIVE=1 不直观 |
| 12 | Agent 会话无自动恢复 | P0 | 🔴 待修复 | 重启后需 API 逐个 resume |
| 13 | respond_task 不在 inbox 投递 | P2 | 🔄 待排期 | 发件人需手动 list_my_tasks 查结果 |

---

## 详细分析

### #8: 服务器重启后 PTY 全部丢失 🔴 P0

**时间**: 2026-07-16 重启验证时
**描述**: POST /api/shutdown → npx boos 重启后，4 个 Agent 终端（全栈架构师/前端/平台集成/可靠性）全部 `status: "exited"`。`boos_terminal_list` 返回空数组，Agent 完全离线。

**影响**: 
- wake_agent 失败（#9）
- send_task 虽然入队，但 Agent 无法收取
- 整个协作管道断裂

**当前 workaround**: 通过 POST /api/sessions/:id/resume API 逐个恢复
**优化方向**: 
1. 服务器启动时自动 resume 所有 `status: "running"` 或上次活跃的 session
2. 或提供一个 `/api/sessions/resume-all` 批量恢复端点
3. 前端 "全部恢复" 按钮

---

### #9: wake_agent 强依赖 PTY，SSE 降级未生效 🔴 P0

**时间**: 2026-07-16 全管道测试
**描述**: PTY 离线时调用 `wake_agent`，返回 `{ ok: false, error: "agent PTY not available" }`。Sprint 16 的双通道设计（SSE 主通道 + PTY fallback ping）理论上 SSE 应独立工作，但当前实现在 PTY 不可用时直接报错退出，未走 SSE-only 路径。

**根因**: `notifications.js` 中 `wakeAgent` 在 session 解析失败时 immediate return，未尝试 SSE-only 投递。
**优化方向**:
1. `wakeAgent` 改为 SSE-first：先通过 `notifyAgent()` 投递，PTY ping 为 optional
2. PTY 不可用 ≠ 通知失败，仅降级处理
3. 返回结果区分 "SSE 已投递 + PTY 已 ping" / "仅 SSE 已投递"

---

### #12: Agent 会话无自动恢复 🔴 P0

**时间**: 2026-07-16 重启验证
**描述**: 服务器重启不会自动恢复任何 Agent session。需通过 API 逐个调用 `/api/sessions/:id/resume`。Session resume 本身工作正常（spawn CC + PTY），但没有触发机制。

**影响**: 与 #8 联动 — 即使 session 记录说 `status: "running"`，实际 PTY 在重启后消失。
**优化方向**:
1. 服务器启动时扫描 sessions.json，对 `status !== "exited"` 的 session 自动 resume
2. 或配置项 `autoResume: true` 控制行为

---

### #7: 路由注册顺序依赖 ✅ 已修复

**时间**: 2026-07-16 root-inbox 验证
**描述**: `GET /api/decisions/root-inbox` 在 `GET /api/decisions/:id` 之后注册，Express 将 `root-inbox` 匹配为 `:id` 参数，返回 `"Decision not found"`。

**修复**: 将 root-inbox 路由移到 `:id` 之前 + 加注释说明顺序依赖
**教训**: 自动化测试应覆盖路由冲突场景；Express 路由注册工具应 warn 潜在 shadowing

---

### #10: MCP 连接不自动重连 🔄 P1

**时间**: 2026-07-16 重启后
**描述**: 旧服务器 shutdown → SSE 连接断开 → 新服务器启动 → Claude Code 的 MCP 客户端未自动重连 `/mcp/sse`。36 个 agent-bus 工具全部消失，需用户重启 Agent 终端会话。

**优化方向**:
1. Claude Code 侧: MCP SSE reconnect 配置
2. BOOS 侧: 服务器 gracefulShutdown 时发送 `retry` 指令，告知客户端重连延迟
3. 或使用 `mcp.json` 的 `reconnect` 选项

---

### #11: 无前端=120s 自动退出 🔄 P1

**时间**: 2026-07-16 无头启动
**描述**: `npx boos` 启动后，如果没有浏览器连接，120s 后自动 shutdown。纯 API/headless 场景需 `BOOS_KEEP_ALIVE=1`，但环境变量不直观。

**日志**: `[boos] shutting down · no frontend connected within 120s of boot`
**优化方向**:
1. `BOOS_NO_BROWSER=1` 时自动启用 keep-alive
2. 或在启动日志中提示 "no browser mode — use BOOS_KEEP_ALIVE=1 to prevent auto-shutdown"

---

### #13: respond_task 不在 inbox 投递 🔄 P2

**时间**: 2026-07-16 E2E 测试
**描述**: 前端工程师 respond_task 后，任务 status 变为 completed，result 存储正确，但发送方（PM）的 `check_inbox` 返回 empty。需主动调用 `list_my_tasks` 查看完成状态。

**Sprint 16 设计**: `_onTaskCompleted` → SSE transport `notifyAgent` → agent MCP session
**待验证**: SSE notification 是否实际到达发送方的 MCP 客户端
**优化方向**:
1. 如果 SSE notifyAgent 未送达，考虑在 respond_task 时创建 completion 通知任务
2. 或提供 `/api/tasks/completed` 端点返回最近完成的发送方任务

---

### #5: Agent 响应超时无感知 🔄 P2

**时间**: 2026-07-16 全流程
**描述**: PM 派发任务后，无机制判断 Agent 是否真正开始工作。Agent 可能:
- 正在处理（正常延迟）
- CLAUDE.md 未加载 check_inbox 工作流（配置问题）
- CC 启动中（启动延迟 ~15s）
- 已离线（PTY 断开）

**优化方向**:
1. `send_task` 后设置期望响应窗口（如 60s）
2. 超时后自动 `wake_agent` 重试
3. `list_my_tasks` 增加 "等待回复" 筛选

---

### #1: Edit 工具 Emoji/中文匹配失败 🔄 P1

**时间**: 2026-07-16 Phase 1
**描述**: Edit 工具 old_string 含 emoji/中文时匹配失败，需 Node.js 脚本 workaround
**优化方向**: 统一 Read/Edit Unicode 规范化；或提供行号范围编辑

---

### #4: 脚本编辑残留代码 🔄 P2

**时间**: 2026-07-16 Phase 1
**描述**: Node.js replace 操作可能产生残留/重复代码
**优化方向**: 脚本修改后自动 `node --check` + brace balance 检测

---

## 优先修复建议

### Sprint 17 (紧急 — 影响协作可用性)

| 优先级 | 阻塞点 | 负责人 |
|:--:|------|------|
| P0 | #8 + #12: 服务器重启后 session 自动恢复 | PM |
| P0 | #9: wake_agent SSE-only 降级路径 | 平台集成 |
| P1 | #10: MCP 自动重连 | 平台集成 |

### Sprint 18 (体验优化)

| 优先级 | 阻塞点 | 负责人 |
|:--:|------|------|
| P1 | #11: NO_BROWSER → 自动 keep-alive | PM |
| P2 | #5: 任务超时感知 | 平台集成 |
| P2 | #13: respond_task 完成通知 | 平台集成 |
| P2 | #1 + #4: 编辑工具 + 脚本校验 | 前端 |

---

*最后更新: 2026-07-16 · 本次 session E2E 验证完成*
