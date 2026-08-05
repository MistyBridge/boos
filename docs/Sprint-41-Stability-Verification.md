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

## Phase 2: DAG/Goal 前端集成验证 (A3 + PM)

### 2.1 前端组件验收
- [ ] GoalListPage (`/goals`) — 卡片列表，活跃/归档 tabs
- [ ] NewGoalPage (`/goals/new`) — 创建表单
- [ ] GoalDetailPage (`/goals/:goalId`) — DAG 图 + 反馈 + 启停
- [ ] CompositeDagGraph — dagre+SVG，缩放/拖拽
- [ ] DagNodeModal — 4 tabs: 详情/选择题/反馈/历史
- [ ] GoalNotification — 右下角弹窗
- [ ] 路由注册 (App.js) + 导航项 (Sidebar.js)

### 2.2 MCP Tools 集成测试
- [ ] goal_create/list/status/start/pause 端到端
- [ ] dag_add_questions/answer_question 端到端
- [ ] dag_status 返回正确 DAG 状态

---

## Phase 3: 技术债务清理 (PM + A4)

### 3.1 store.js 重构
- [ ] 当前 418 行，拆分为 2-3 个模块
- [ ] 提取 task operations → `storeTasks.js` (已删除，需重新设计)
- [ ] 提取 agent operations → `storeAgents.js`
- [ ] 保留 store.js 作为 facade (< 200 行)

### 3.2 代码清理
- [ ] 移除临时文件 (tmp-*.js)
- [ ] 清理过时的注释和文档
- [ ] 统一错误处理模式

### 3.3 测试覆盖
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

## 团队派发

| 成员 | 任务 | 优先级 |
|------|------|:--:|
| PM (A1) | Phase 1, Phase 3.1-3.2 | P0 |
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
