# Sprint 36 任务排期

> 日期: 2026-08-02 → 2026-08-04 | PM: 全栈架构师_PM-A1 | 主题: 稳定化 + PMO 升级链 + 测试覆盖

---

## 总体目标

1. **修复 Bug**: respond_task 竞态条件、超时扫描器适配 inbox 结构
2. **PMO 升级链**: PM 兼容 PMO 职责，确保 escalated 任务不丢
3. **测试覆盖**: 前端零测试突破 + 后端薄弱模块补测
4. **前端稳定**: SSE 重连、错误上报

---

## Phase 1 — Bug 修复 (Day 1, 8h)

| # | 任务 | 负责人 | 预计 | 依赖 |
|---|------|--------|------|------|
| P1-1 | `respond_task` 竞态条件修复 — 移除 `handlers.js` sync pre-check，纯走 `queue.respondTask()` | PM | 2h | — |
| P1-2 | `taskTimeout.js` 适配 inbox — 扫描 `~/.boos/agent-bus/inbox/*.json` 替代 `agent-bus.json` | PM | 2h | — |
| P1-3 | `heartbeat.js` 适配 inbox — `_reassignTasks` 扫描 inbox 文件替代共享 store | PM | 2h | — |
| P1-4 | DAG 任务超时扫描 — 新增 `dagTimeout.js`，扫描 `dag_tasks` 中 stuck in `active` > 24h | PM | 2h | — |

## Phase 2 — PMO 升级链 (Day 1-2, 6h)

| # | 任务 | 负责人 | 预计 | 依赖 |
|---|------|--------|------|------|
| P2-1 | PM 兼容 PMO 职责 — escalated 任务处理流程文档化 + 决策记录 | PM | 2h | P1-1 |
| P2-2 | `pmoEngine.js` 激活 — 5 分钟轮询 loop + PM 健康检测 | PM | 2h | P2-1 |
| P2-3 | 超时升级: PM 30min 未处理 → PMO / Human 决策区 | PM | 2h | P2-2 |

## Phase 3 — 测试覆盖 (Day 2, 8h)

| # | 任务 | 负责人 | 预计 | 依赖 |
|---|------|--------|------|------|
| P3-1 | 前端基础测试框架搭建 (vitest + jsdom) | A3 | 3h | — |
| P3-2 | 前端核心组件测试 (App, Sidebar, TerminalView) | A3 | 3h | P3-1 |
| P3-3 | `sandbox.js` 单元测试补全 | A2 | 1h | — |
| P3-4 | `rateLimiter.js` 单元测试补全 | A2 | 1h | — |
| P3-5 | `sessionBinding.js` 单元测试补全 | A2 | 1h | — |
| P3-6 | `respond_task` 回归测试 | A2 | 2h | P1-1 |

## Phase 4 — 前端稳定 (Day 2-3, 6h)

| # | 任务 | 负责人 | 预计 | 依赖 |
|---|------|--------|------|------|
| P4-1 | SSE 指数退避重连 — `transport.js` + `api.js` 前端侧 | A3 / A4 | 3h | — |
| P4-2 | ErrorBoundary 覆盖剩余页面 | A3 | 2h | — |
| P4-3 | 前端错误日志收集端点 `POST /api/errors` | PM | 1h | — |

## Phase 5 — 代码质量 (Day 3, 4h)

| # | 任务 | 负责人 | 预计 | 依赖 |
|---|------|--------|------|------|
| P5-1 | ConfigurePage 继续拆分 (927 → ≤500) | A3 | 2h | — |
| P5-2 | CSS 去重合并 (16 → 10 文件) | A3 | 2h | — |

---

## 派发计划

| 时间 | 动作 |
|------|------|
| **Day 1 上午** | PM 做 P1-1~P1-4 (Bug 修复，全后端) |
| **Day 1 下午** | PM 做 P2-1~P2-2 (PMO 升级链)；wake A3 派发 P3-1；wake A2 派发 P3-3~P3-5 |
| **Day 2 上午** | A3 做 P3-1~P3-2；A2 做 P3-3~P3-6；PM 做 P2-3 |
| **Day 2 下午** | A3/A4 协作 P4-1；A3 做 P4-2；PM 做 P4-3 |
| **Day 3 上午** | A3 做 P5-1~P5-2；PM 回归测试 + 集成验证 |
| **Day 3 下午** | Buffer / 文档更新 / 提交推送 |

---

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| A3/A2/A4 未响应 wake | 中 | PM 兜底，但优先等待 agent 响应 |
| inbox 改造引入回归 | 低 | P3-6 respond_task 回归测试覆盖 |
| PMO 引擎复杂度超预期 | 低 | Phase 2 可分拆到下个 Sprint |

---

## 完成标准

- [ ] 4 个 Bug 全部修复 + 测试通过
- [ ] PMO 升级链可演示 (escalated → PM → Human)
- [ ] 前端测试从 0 → ≥10 用例
- [ ] 后端新增测试模块 ≥3
- [ ] SSE 断线重连可用
- [ ] 无已知 P0 Bug
