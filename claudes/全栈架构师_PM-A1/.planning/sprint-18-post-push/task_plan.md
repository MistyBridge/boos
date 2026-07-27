# Sprint 18 Post-Push Plan — 不受重启限制的任务

> 创建: 2026-07-19 | 状态: in_progress
> 约束: 不重启 BOOS 服务器（运行的还是旧代码）
> 代码已推送: 215c3ec `main`

## Phase 1: 清理僵尸 pending 任务 (PM)

**文件**: `~/.boos/agent-bus.json`
**现状**: 333 pending 任务，大量是 7/15-17 测试创建的僵尸，从未被 claim
**操作**:
1. 分析 pending 任务的 sender/receiver 分布
2. 清理指向不存在 agent 的任务
3. 清理指向非活跃 session 的任务
4. 保留指向活跃 agent 的有效 pending

**通过标准**: pending 任务数降至活跃 agent 实际待处理数

## Phase 2: GitHub Pages 前端部署 (PM + 前端工程师)

**问题**: `state.js` / `Sidebar.js` / `sidebar.css` 的 HR Agent 侧边栏变更在 `public/` 中，用户通过 `https://MistyBridge.github.io/boos/` 访问的是旧版本
**操作**:
1. 检查 push 后的 Pages workflow 是否自动触发
2. 验证 `/<1.0.1>/` 目录是否已有最新 public/ 文件
3. 如未部署 → 触发 Pages workflow

**通过标准**: `MistyBridge.github.io/boos/1.0.1/js/state.js` 包含 `hrAgentSession`

## Phase 3: 安全审计 (可靠性工程师)

**范围**:
- CORS allow-list 审计（是否允许了非预期 origin）
- WebSocket Origin 校验（是否与 CORS 同步）
- `/api/shutdown` / `/api/upgrade` 是否需要认证
- `/mcp/sse` 端点是否有限流
- `BOOS_HOME` 环境变量注入风险

**通过标准**: 审计报告，0 critical/high

## Phase 4: agent-bus.json 剩余清理

**操作**:
- 检查 92 agents 中是否有僵尸（无 session、无活跃任务、7 天未活动）
- 检查 sessions 映射的完整性
- 检查 identity cards 的完整性

## 派发

| Phase | Owner | 方式 |
|-------|-------|------|
| 1 | PM | 直接执行 |
| 2 | 前端工程师 | send_task |
| 3 | 可靠性工程师 | send_task |
| 4 | PM | 直接执行 |
