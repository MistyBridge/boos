# Sprint 41 — 稳定性验证 + 技术债务清理 (2026-08-05)

> **目标**: 验证 v1.2.0 核心功能，清理技术债务，为后续开发打基础。

---

## Phase 1: 会话恢复验证 (PM) ✅

### 1.1 Session Resume Bug 验证 ✅
- [x] 关闭 BOOS → 重启 → 验证 agent 对话历史保留
- [x] 验证 `~/.claude/projects/<slug>/<uuid>.jsonl` fallback 检测
  - 48 project slugs 检测成功
  - 79 JSONL files 扫描成功
  - 79 valid UUID files (100% 匹配率)
- [x] 验证 `cliSessionId` 正确绑定
- [x] 验证 `--resume <id>` 参数正确生成

### 1.2 PTY 注入稳定性 ✅
- [x] 验证 agent 启动后 8s 注入 `check_inbox[BOOS]`
- [x] 验证 `wake_agent` PTY 注入可靠性
- [x] 验证 bracketed-paste 方案兼容性

---

## Phase 2: DAG/Goal 前端集成验证 (A3 + PM) ✅

### 2.1 前端组件验收 ✅
- [x] GoalListPage (`/goals`) — 卡片列表，活跃/归档 tabs
- [x] NewGoalPage (`/goals/new`) — 创建表单
- [x] GoalDetailPage (`/goals/:goalId`) — DAG 图 + 反馈 + 启停
- [x] CompositeDagGraph — dagre+SVG，缩放/拖拽
- [x] DagNodeModal — 4 tabs: 详情/选择题/反馈/历史
- [x] GoalNotification — 右下角弹窗
- [x] 路由注册 (App.js) + 导航项 (Sidebar.js)

### 2.2 MCP Tools 集成测试 ✅
- [x] goal_create/list/status/start/pause 端到端
- [x] dag_add_questions/answer_question 端到端
- [x] dag_status 返回正确 DAG 状态

---

## Phase 3: 技术债务清理 (PM + A4) 🔄

### 3.1 store.js 重构 ✅
- [x] 当前 418 行 → 拆分 6 模块 (storeCore/storeAgents/storeTasks/storeIdentity/inboxStore/store facade)
- [x] 提取 task operations → `storeTasks.js`
- [x] 提取 agent operations → `storeAgents.js`
- [x] 保留 store.js 作为 facade (< 200 行)
- [x] 任务已派发 A4: `task_msfor5pi_os2qbs`
- [x] **PM 修复**: `atomicJson.js` 加 parent-dir mkdir (修 ENOENT lock)；`handlers.test.js` CLEAR_MODS 补 storeAgents/storeTasks

### 3.2 代码清理
- [ ] 移除临时文件 (tmp-*.js)
- [ ] 清理过时的注释和文档
- [ ] 统一错误处理模式

### 3.3 测试覆盖
- [x] burst 测试修复: 4 个失败 → 5/5 pass (cliSessionId + getArchivedTask + settle_task)
- [x] handlers.test.js 103/103 pass (CLEAR_MODS 隔离修复)
- [ ] 新增代码测试覆盖率 ≥ 80%
- [ ] 修复 flaky tests (如有)

---

## Phase 4: 跨平台支持调研 (A4)

### 4.1 Mac/Linux 可行性
- [ ] 评估 `scripts/install.js` 跨平台改造
- [ ] 评估 PTY 注入跨平台兼容性
- [ ] 评估 `boos://` protocol handler 跨平台方案

### 4.2 文档更新
- [ ] 更新 README.md 跨平台安装指南
- [ ] 更新 CLAUDE.md 跨平台开发注意事项

---

## Phase 5: Prompt 缓存命中率修复 — Agent-Bus Router Mode (PM) ✅

### 5.1 问题分析

**症状**: 在 BOOS 中运行的 Claude Code 会话 prompt cache 命中率 < 30%。

**根因**: Anthropic prompt cache 是 prefix 匹配的。Claude Code 的 system prompt 中
工具定义段位于最前，而 agent-bus 通过 SSE 暴露 **68 个工具**，导致：

1. **MCP 连接漂移** — agent-bus SSE 在 session 启动后异步握手，工具列表在首请求与
   重连后不一致 → 工具定义段变化 → 整轮 miss
2. **工具集巨大** — 68 个 schema 塞满 system prompt 前端（~30k tokens），任何变化
   都使前缀失效

### 5.2 方案: Router Mode（恒值工具面）

把 agent-bus 工具面收敛为 **3 个恒定工具**（`lib/agentBus/routerMode.js`）：

| 工具 | 作用 |
|------|------|
| `check_inbox` | 保留独立（PTY 唤醒契约，schema 为零参数 `{}`） |
| `agent_bus_list_tools` | 按需查目录/单工具完整 schema |
| `agent_bus_call` | `{tool_name, args}` 路由到真实 dispatcher |

**效果**: 工具定义段从 ~68 工具 → 3 工具，恒定不变。完整 schema 只在 agent 需要时
通过 `agent_bus_list_tools({tool_name})` 获取（进入对话后半段，不影响缓存前缀）。

**开关**: `BOOS_MCP_ROUTER_MODE=1`（默认开）| `0`（传统全量工具面）。

### 5.3 顺带修复 (transport.js)

- `SSE_MIN_RECONNECT_INTERVAL_MS=0` 现在真正禁用 backoff（此前 `parseInt||1000` 使 0 失效）
- `_pruneTimer` 加 `.unref()` — 60s 清理定时器不再阻止进程退出

### 5.4 文件变更

| 文件 | 变更 |
|------|------|
| `lib/agentBus/routerMode.js` | **新增** — ROUTER_TOOLS + isRouterMode() |
| `lib/agentBus/transport.js` | tools/list 按模式返回；tools/call 处理 router 工具 |
| `lib/supervisorPrompt.js` | 协作 prompt 更新为 router 模式用法 |
| `tests/agentBus-router.test.js` | **新增** — 8 单测 + 4 SSE 集成测试 (12 pass) |

**测试**: `tests/agentBus-router.test.js` 12/12 pass · schemas 12/12 pass ·
store.test.js 162/162 pass。

### 5.5 待办

- [ ] 各 agent CLAUDE.md 更新为 router 模式用法
- [ ] 实测缓存命中率回升验证

---

## 团队派发

| 成员 | 任务 | 优先级 |
|------|------|:--:|
| PM (A1) | Phase 1, Phase 3.1-3.2, Phase 5 | P0 |
| A2 (可靠性) | Phase 2.2 MCP 集成测试 | P1 |
| A3 (前端) | Phase 2.1 前端组件验收 | P1 |
| A4 (平台) | Phase 3.3, Phase 4 | P2 |
| PMO (A5) | 发布流程监督 | P3 |

---

## 时间规划

| Phase | 预计耗时 | 截止日期 |
|-------|----------|----------|
| Phase 1: 会话恢复验证 | 1 天 | 2026-08-06 |
| Phase 2: 前端集成验证 | 2 天 | 2026-08-08 |
| Phase 3: 技术债务清理 | 2 天 | 2026-08-10 |
| Phase 4: 跨平台调研 | 1 天 | 2026-08-11 |
| **总计** | **6 天** | **2026-08-11** |

---

*创建时间: 2026-08-05*
*最后更新: 2026-08-05*
