# Sprint 17 — 任务仪表盘 + 前端稳定性 + 阻塞点修复

> 开始: 2026-07-16 | 状态: 🔄 执行中
> PM: 全栈架构师 (agent_mrjzz7n7_6f12d5)

---

## 背景

三个核心诉求:
1. Agent 协作任务在 BOOS 仪表盘可视化（当前只能看到 human↔agent 的 root-inbox）
2. 前端 UI 频繁撕裂/闪烁 — 需用稳定组件模式重构
3. P0 阻塞点修复 — 服务器重启后协作管道断裂

---

## 任务清单

### Theme A: Agent 协作仪表盘 (7 tasks)

| ID | 任务 | 负责人 | 状态 | 文件 |
|----|------|--------|:--:|------|
| A1 | GET /api/agent-bus/tasks 端点 | PM | 🔜 | routes/agents.js + store.js |
| A2 | GET /api/agent-bus/tasks/:id 端点 | PM | 🔜 | routes/agents.js |
| A3 | SSE 推送非 root 任务生命周期事件 | 平台集成 | 📨 | notifications.js |
| A4 | 前端 tasks signal + API 接入 | 前端 | 📨 | state.js, api.js, main.js |
| A5 | AgentTaskDashboard 组件 | 前端 | 📨 | components/AgentTaskDashboard.js |
| A6 | 集成到 DecisionsPage (新增"任务"tab) | 前端 | 📨 | pages/DecisionsPage.js |

### Theme B: 前端 UI 稳定性 (4 tasks)

| ID | 任务 | 负责人 | 状态 | 文件 |
|----|------|--------|:--:|------|
| B1 | App.js SSE 事件批量合并 (P0) | 前端 | 📨 | components/App.js |
| B2 | Terminal resize 连锁 layout 修复 | 前端 | 📨 | TerminalInstance.js |
| B3 | CSS contain + will-change 加固 | 前端 | 📨 | terminals.css, sidebar.css |
| B4 | 前端渲染性能基准测试 + E2E | 可靠性 | 📨 | tests/e2e/rendering-perf.spec.js |

### Theme C: P0 阻塞点修复 (4 tasks)

| ID | 任务 | 负责人 | 状态 | 文件 |
|----|------|--------|:--:|------|
| C1 | server 启动自动 resume session | PM | 🔜 | server.js |
| C2 | POST /api/sessions/resume-all | PM | 🔜 | routes/sessions.js |
| C3 | wake_agent SSE-only 降级 | 平台集成 | 📨 | notifications.js |
| C4 | BOOS_NO_BROWSER → 自动 keep-alive | 平台集成 | 📨 | server.js |

### Theme D: 任务通知增强 (2 tasks)

| ID | 任务 | 负责人 | 状态 | 文件 |
|----|------|--------|:--:|------|
| D1 | respond_task 完成通知投递 inbox | 平台集成 | 📨 | notifications.js |
| D2 | 任务超时检测 + 自动重试 + escalate | 平台集成 | 📨 | notifications.js, queue.js |

---

## 进度追踪

| 主题 | 总任务 | 已完成 | 进行中 | 待开始 |
|------|:--:|:--:|:--:|:--:|
| A: 任务仪表盘 | 7 | 0 | 0 | 7 |
| B: 前端稳定性 | 4 | 0 | 0 | 4 |
| C: P0 阻塞点 | 4 | 0 | 0 | 4 |
| D: 通知增强 | 2 | 0 | 0 | 2 |
| **合计** | **17** | **0** | **0** | **17** |

### 修改文件汇总

```
routes/agents.js              — A1, A2 (新增 2 个端点)
lib/agentBus/store.js         — A1 (新增 listAllTasks)
lib/agentBus/notifications.js — A3, C3, D1, D2 (任务生命周期 SSE + 降级 + 超时)
server.js                     — C1, C4 (自动 resume + keep-alive)
routes/sessions.js            — C2 (batch resume)
public/js/state.js            — A4 (tasks signal)
public/js/api.js              — A4 (fetchTasks)
public/js/main.js             — A4 (tasks 轮询)
public/js/components/App.js   — B1 (SSE 批量合并)
public/js/components/TerminalInstance.js — B2 (resize 去抖)
public/js/components/AgentTaskDashboard.js — A5 (新建)
public/js/pages/DecisionsPage.js — A6 (任务 tab)
public/css/sidebar.css        — B3 (will-change)
public/css/terminals.css      — B3 (contain)
tests/e2e/rendering-perf.spec.js — B4 (新建)
docs/sprint-17-perf-baseline.md — B4 (新建)
```

---

## 依赖关系

```
A1 ──→ A4 ──→ A5 ──→ A6    (后端 API → 前端接入 → 组件 → 集成)
A3 ──→ A4                   (SSE 事件 → 前端实时更新)
C3 依赖 A3 (SSE 基础设施)
B1, B2, B3 可并行 (独立组件)
B4 依赖 B1+B2+B3 (测修复后效果)
```

### 协作约定
- PM 修改 lib/ 或 server.js 前获取 file_lock
- 前端修改 public/ 前在 agent-bus 告知 PM
- 平台集成修改 notifications.js 前获取 file_lock
- 每个任务完成后 respond_task 汇报结果
- 不可修复的阻塞点 → send_to_root → 决策区

---

*最后更新: 2026-07-16 · PM: 全栈架构师*
