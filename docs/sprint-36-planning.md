# Sprint 36 任务排期

> 日期: 2026-08-02 → 2026-08-04 | PM: 全栈架构师_PM-A1 | 主题: 稳定化 + 文档清理 + 测试覆盖
> 更新: 2026-08-02 (Phase 1 完成, Phase 0 完成)

---

## 总体目标

1. ~~**修复 Bug**: respond_task 竞态条件、超时扫描器适配 inbox 结构~~ ✅ Phase 1 完成
2. ~~**清理轮询**: 删除所有 agent 驱动的轮询机制~~ ✅ Phase 0 完成
3. **测试覆盖**: 前端零测试突破 + 后端薄弱模块补测
4. **PMO 升级链**: PM 兼容 PMO 职责（留待下个 Sprint）

---

## Phase 0 — 废除 Agent 轮询 (已完成 ✅)

> 背景: Sprint 21 废除了 `check_inbox(wait=true)` + `check_decisions` + `check_root_response`，
> 但部分文档和模板仍残留旧的轮询指令。BOOS 代码层已完全接管所有轮询。

| # | 任务 | 状态 |
|---|------|:--:|
| P0-1 | 删除 `wake-template.md` (Sprint 17 阻塞等待模板，含 `check_inbox(wait=true)` loop) | ✅ |
| P0-2 | 更新 PM CLAUDE.md — 移除 `pmo_poll` 代码示例，标注 escalated 由代码层检测 | ✅ |
| P0-3 | 更新 `pmoEngine.js` 注释 — 移除 `handlersDag._pmoPoll` / `pmo_poll MCP tool` 引用 | ✅ |
| P0-4 | 升级 agent 模板 `claudes$agent/.../SKILL.md` — v2.1 (阻塞 wait) → v3.0 (事件驱动) | ✅ |
| P0-5 | 修正 A2 CLAUDE.md 技能标签 "Agent-Bus 任务轮询" → "Agent-Bus 事件驱动协作" | ✅ |

## Phase 1 — Bug 修复 (已完成 ✅)

| # | 任务 | 状态 |
|---|------|:--:|
| P1-1 | `respond_task` 竞态条件修复 — Sprint 35 已完成 (移除 sync pre-check) | ✅ |
| P1-2 | `taskTimeout.js` 适配 inbox — 扫描 per-agent `inbox/*.json` 替代 `agent-bus.json` | ✅ |
| P1-3 | `heartbeat.js` 适配 inbox — `_reassignTasks` 使用 `inboxStore` 替代共享 store | ✅ |
| P1-4 | DAG 任务超时扫描 — 新增 `dagTimeout.js`, 每 2min 扫描, >24h 自动 escalate | ✅ |

**已提交**: `325ce92` (Sprint 35), `9d75fd5` (规划文档), `9f3b788` (Phase 1)

---

## Phase 2 — 测试覆盖 (待派发)

| # | 任务 | 负责人 | 预计 |
|---|------|--------|------|
| P2-1 | 前端基础测试框架搭建 (vitest + jsdom) | A3 | 3h |
| P2-2 | 前端核心组件测试 (App, Sidebar, TerminalView) | A3 | 3h |
| P2-3 | `sandbox.js` 单元测试补全 | A2 | 1h |
| P2-4 | `rateLimiter.js` 单元测试补全 | A2 | 1h |
| P2-5 | `sessionBinding.js` 单元测试补全 | A2 | 1h |

## Phase 3 — 前端稳定 (待派发)

| # | 任务 | 负责人 | 预计 |
|---|------|--------|------|
| P3-1 | SSE 指数退避重连 | A3 / A4 | 3h |
| P3-2 | ErrorBoundary 覆盖剩余页面 | A3 | 2h |
| P3-3 | 前端错误日志收集端点 `POST /api/errors` | PM | 1h |

## Phase 4 — 代码质量 (待派发)

| # | 任务 | 负责人 | 预计 |
|---|------|--------|------|
| P4-1 | ConfigurePage 继续拆分 (927 → ≤500) | A3 | 2h |
| P4-2 | CSS 去重合并 (16 → 10 文件) | A3 | 2h |

---

## 下个 Sprint (37) 候选

| 优先级 | 任务 | 说明 |
|--------|------|------|
| P1 | PMO 升级链 Phase 2 | pmoEngine 定时器激活 + PM 30min 超时升级 |
| P1 | 前端 SSE 重连 | 指数退避，断线自动恢复 |
| P2 | 跨平台 macOS/Linux | 启动脚本已有骨架，需 E2E 验证 |
| P2 | MCP Streamable HTTP | 2025 spec，替代 SSE |

---

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| A3/A2/A4 未响应 wake | 中 | PM 兜底，但优先等待 agent 响应 |
| 前端测试框架搭建耗时 | 低 | 选择 vitest (与 Vite/Preact 生态兼容) |

---

## 完成标准 (Sprint 36)

- [x] 4 个 Bug 全部修复 ✅
- [x] Agent 轮询机制全部清理 ✅
- [ ] 前端测试从 0 → ≥10 用例
- [ ] 后端新增测试模块 ≥3
- [ ] 无已知 P0 Bug
