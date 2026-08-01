# BOOS 项目 Backlog

> 最后更新: 2026-08-02 | 当前版本: v1.2.0-dev | 当前 Sprint: 36

---

## Bug 修复 (P0)

| # | 问题 | 影响 | 负责人 | 状态 |
|---|------|------|--------|:--:|
| B1 | `respond_task` 竞态条件 — 移除 sync pre-check，纯走 queue.respondTask() | Sprint 35 | PM / A4 | ✅ |
| B2 | `taskTimeout.js` 扫描旧 store → 适配 per-agent inbox 文件 | Sprint 36 P1 | PM | ✅ |
| B3 | `heartbeat.js` 崩溃恢复扫描旧 store → 适配 inbox | Sprint 36 P1 | PM | ✅ |
| B4 | DAG 任务无超时机制 → 新增 `dagTimeout.js` | Sprint 36 P1 | PM | ✅ |
| B5 | 前端零测试覆盖 | 回归风险高 | A3 | 🔴 待开始 |

---

## 功能增强 (P1)

| # | 功能 | 说明 | 负责人 | 状态 |
|---|------|------|--------|:--:|
| F1 | SSE 指数退避重连 | 前端断线后智能重连，避免雪崩 | A3 / A4 | ⚪ 待开始 |
| F2 | 前端错误上报 + 性能监控 | ErrorBoundary 集成 Sentry/自建 | A3 | ⚪ 待开始 |
| F3 | PMO 引擎启用 | 激活 `pmoEngine.js`，PM 故障检测 + 5 分钟轮询 | PM | ⚪ 待开始 |
| F4 | 升级链完整实现 | Agent → PM → PMO → Human 三级升级 | PM | ⚪ 待开始 |
| F5 | DAG 任务超时扫描 | 对标 `taskTimeout.js` 但扫描 `dag_tasks` | PM | ⚪ 待开始 |

---

## 技术债务 (P2)

| # | 项目 | 说明 | 负责人 | 状态 |
|---|------|------|--------|:--:|
| T1 | 12 个前端文件超 500 行限制 | ConfigurePage (927), SessionsPage, LaunchPage 等 | A3 | ⚪ 待开始 |
| T2 | 16 个 CSS 文件 — 考虑 PostCSS 合并 | 减少 HTTP 请求，统一变量 | A3 | ⚪ 待开始 |
| T3 | `_syncLoad` 调用方迁移 | 旧同步 API → 异步 PG adapter | A4 | 🔒 blocked |
| T4 | 跨平台 macOS/Linux 启动脚本 | `scripts/start-darwin.sh` / `start-linux.sh` 已有骨架 | A4 | ⚪ 待开始 |
| T5 | MCP Streamable HTTP (2025 spec) | 替代 SSE 的下一代传输协议 | A4 | ⚪ 待开始 |
| T6 | 16 个 lib 模块缺测试覆盖 | sandbox, rateLimiter, sessionBinding, idleWatcher 等 | A2 | ⚪ 待开始 |
| T7 | 回归测试 + 安全审计 | Sprint 16 遗留 | A2 | 🔒 blocked |

---

## Sprint 历史

| Sprint | 主题 | 状态 |
|--------|------|:--:|
| 1-6 | 基础架构 + Agent-Bus + v1.0.1 | ✅ |
| 21 | 废除轮询，纯事件驱动 | ✅ |
| 22 | 统一原子身份索引 | ✅ |
| 23 | v1.1.0 Release + SSE 加固 | ✅ |
| 24-27 | AutoPilot + 决策区 2.0 + 前端加固 | ✅ |
| 31 | DAG 任务系统 | ✅ |
| 32 | 稳定化 + 前端仪表盘 | ✅ |
| 33 | Identity 严格 1:1 约束 | ✅ |
| 34 | (合并入 35) | — |
| 35 | 任务生命周期修复 + 身份同步加固 + 前端依赖本地化 | ✅ |
| **36** | **当前: Bug 修复 + 轮询清理 + 测试覆盖 (进行中)** | 🔄 |

---

## 团队分工

| 角色 | UID (后8位) | 职责 |
|------|-------------|------|
| 全栈架构师_PM-A1 | `5dabdd` | 架构、后端、路由、DB、PMO |
| 前端工程师-A3 | `be2bb0` | Preact、CSS、xterm.js、UI |
| 平台集成工程师-A4 | `98686a` | Agent-Bus、MCP、SSE、跨平台 |
| 可靠性工程师-A2 | `5d1cab` | 测试、E2E、安全审计、CI/CD |

---

## 约束规则

1. **PM 不自己做所有事** — 前端 → A3，集成 → A4，测试 → A2
2. **不盲猜** — agent 无法判断时必须升级
3. **文件锁** — 修改 `lib/` 或 `server.js` 前 `request_file_lock`
4. **代码规范** — 单文件 ≤500 行，新功能必有测试
5. **事件驱动** — 零轮询，SSE 推送 + PTY 注入 + auto-wake
