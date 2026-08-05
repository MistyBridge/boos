# Sprint 40 — v1.2.0 Release 准备 + 功能增强 (2026-08-05)

> **目标**: 完成 v1.2.0 发布准备，包含 Sprint 37-39 的所有改进。
> **当前版本**: 1.1.0 (2026-07-19) → **目标版本**: 1.2.0

---

## Phase 1: Sprint 37-39 验收 (PM)

### 1.1 Sprint 37 DAG 目标系统验收
- [ ] 验证 30 个 MCP tools 功能完整性
- [ ] 验收 A3 完成的 7 个前端组件
  - GoalListPage, NewGoalPage, GoalDetailPage
  - CompositeDagGraph, DagNodeModal
  - GoalNotification, 路由注册
- [ ] 验收 A2 完成的集成测试
- [ ] 验收 A4 完成的 MCP 审计

### 1.2 Sprint 38 PTY 注入验收
- [ ] 验证 PTY 注入可靠性（5 个注入点）
- [ ] 验证 bracketed-paste 方案稳定性
- [ ] 验证 agent 启动加速效果

### 1.3 Sprint 39 安全修复验收
- [ ] 验证 shutdownToken 不再泄漏
- [ ] 验证 TOCTOU 竞态修复（并发测试）
- [ ] 验证 EPIPE 崩溃修复
- [ ] 验证 DAG 任务分发修复

---

## Phase 2: v1.2.0 文档完善 (PM)

### 2.1 CHANGELOG 更新
- [ ] Sprint 37: DAG 目标系统 + 30 MCP tools
- [ ] Sprint 38: PTY 注入修复 + PMO-A5 入职
- [ ] Sprint 39: 安全修复 + 关键 Bug 修复

### 2.2 README 更新
- [ ] 更新架构图（agent-bus 事件驱动）
- [ ] 更新 API 文档（新增 30 个 MCP tools）
- [ ] 更新部署文档

### 2.3 开发文档
- [ ] Sprint 37 设计文档完善
- [ ] Agent-Bus 开发指南
- [ ] MCP 工具使用示例

---

## Phase 3: 性能优化 (PM + A2)

### 3.1 Agent-Bus 性能
- [ ] inbox 文件锁性能测试（per-uid lock vs shared lock）
- [ ] SSE transport 并发连接测试
- [ ] 100 agent 并发压力测试

### 3.2 数据库优化
- [ ] identity_index 查询优化
- [ ] inbox/archive 分区后性能验证
- [ ] DAG 节点查询优化

---

## Phase 4: 代码清理 (PM)

### 4.1 移除临时文件
- [ ] 清理 tmp-*.js 调试脚本
- [ ] 清理 test-*.js 临时测试

### 4.2 代码重构
- [ ] store.js 拆分为多个模块（当前 418 行）
- [ ] handlersDag.js 优化（当前 320 行）
- [ ] 统一错误处理模式

### 4.3 测试覆盖
- [ ] 新增代码测试覆盖率达到 80%+
- [ ] E2E 测试覆盖关键路径
- [ ] 性能基准测试

---

## Phase 5: v1.2.0 Release (PM)

### 5.1 发布准备
- [ ] bump version: 1.1.0 → 1.2.0
- [ ] 更新 package.json + package-lock.json
- [ ] 创建 release commit + tag

### 5.2 GitHub Release
- [ ] 创建 v1.2.0 release notes
- [ ] 验证 CI/CD pipeline
- [ ] 发布到 npm registry

### 5.3 公告
- [ ] 更新 README 版本号
- [ ] 发布 GitHub Release
- [ ] 通知团队成员

---

## 团队派发

| 成员 | 任务 | 优先级 |
|------|------|:--:|
| PM (A1) | Phase 1-2, 5 验收 + 文档 + 发布 | P0 |
| A2 (可靠性) | Phase 3.1 性能测试 + Phase 4.3 测试覆盖 | P1 |
| A3 (前端) | Phase 1.1 前端验收配合 | P2 |
| A4 (平台) | Phase 1.3 MCP 验收配合 | P2 |
| PMO (A5) | 发布流程监督 | P3 |

---

## 时间规划

| Phase | 预计耗时 | 截止日期 |
|-------|----------|----------|
| Phase 1: 验收 | 2 天 | 2026-08-07 |
| Phase 2: 文档 | 1 天 | 2026-08-08 |
| Phase 3: 性能 | 2 天 | 2026-08-10 |
| Phase 4: 清理 | 1 天 | 2026-08-11 |
| Phase 5: 发布 | 1 天 | 2026-08-12 |
| **总计** | **7 天** | **2026-08-12** |

---

## 风险与依赖

### 风险
1. **性能问题**: 100 agent 并发可能暴露新问题
2. **文档缺失**: Sprint 37 设计文档需要补充
3. **测试覆盖**: 新增代码测试覆盖率可能不足

### 依赖
1. **BOOS 服务器**: 需要保持稳定运行
2. **团队成员**: A2/A3/A4 需要配合验收
3. **GitHub**: CI/CD pipeline 正常运行

---

## 成功标准

- [ ] Sprint 37-39 所有功能验收通过
- [ ] 文档完整，CHANGELOG 更新
- [ ] 性能测试通过（100 agent 并发）
- [ ] 测试覆盖率 ≥ 80%
- [ ] v1.2.0 成功发布到 npm
- [ ] 零 P0/P1 bug

---

*创建时间: 2026-08-05*
*最后更新: 2026-08-05*
