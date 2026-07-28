# Sprint 31 — DAG 任务系统 + PMO 架构

> **PM**: 全栈架构师_PM-A1 | **日期**: 2026-07-28 | **状态**: 排期中  
> **完整 Spec**: `specs/dag-task-system-sprint31.md`  
> **每位成员**: 请先阅读完整 spec，再开始自己的 phase

---

## 任务分配

### Phase 1: DAG 数据层 → PM (全栈架构师_PM-A1)

**文件**: `lib/agentBus/dagStore.js` (新), `lib/agentBus/store.js` (改)

**内容**:
- [ ] `dagStore.js`: DAG + dag_tasks CRUD 操作
- [ ] 硬编码校验: `executor_uid !== reviewer_uid`
- [ ] 循环依赖检测: `detectCycle()`
- [ ] `store.js`: 扩展 `agent-bus.json` schema 加 `dags` + `dag_tasks` 字段

**产出**: dagStore.js (~250 行), store.js diff (~80 行), 单元测试

---

### Phase 2: 任务状态机 → 平台集成工程师-A4

**文件**: `lib/agentBus/taskSystem.js` (新), `lib/agentBus/schemas.js` (改), `lib/agentBus/handlers.js` (改)

**内容**:
- [ ] `taskSystem.js`: submit/approve/reject 状态转换 + 权限矩阵硬编码
- [ ] `schemas.js`: 新增 7 个 DAG MCP tools (dag_create, dag_add_task, dag_activate, dag_status, dag_cancel, dag_submit_task, dag_approve_task, dag_reject_task, dag_my_tasks, dag_reassign_task)
- [ ] `handlers.js`: 新增 10 个 handler 函数 + dispatch switch 扩展
- [ ] 权限硬编码: executor 只能 submit, reviewer 只能 approve/reject

**产出**: taskSystem.js (~200 行), schemas.js diff (~200 行), handlers.js diff (~350 行)

---

### Phase 3: DAG 引擎 → PM + 平台集成工程师-A4

**文件**: `lib/agentBus/dagEngine.js` (新), `lib/agentBus/notifications.js` (改), `lib/agentBus/transport.js` (改)

**内容**:
- [ ] `dagEngine.js`: 依赖解锁 (dag_activate 时自动激活无依赖任务)
- [ ] DAG 完成判断: 所有 task approved → DAG completed
- [ ] `notifications.js`: 新增 DAG 任务生命周期 SSE 事件
- [ ] `transport.js`: 新增事件类型注册

**产出**: dagEngine.js (~180 行), notifications.js diff (~120 行), transport.js diff (~30 行)

---

### Phase 4: PMO 引擎 → 平台集成工程师-A4 + PM

**文件**: `lib/agentBus/pmoEngine.js` (新), `routes/agents.js` (改), `HR/assets/roles/pmo.md` (新)

**内容**:
- [ ] `pmoEngine.js`: PMO 注册、5 分钟轮询循环、PM 故障检测
- [ ] PM 恢复流程: launch_agent_session(PM) → wake → 验证
- [ ] `routes/agents.js`: `POST /api/agents/poll` (pmo only 鉴权)
- [ ] `pmo.md`: PMO 角色模板

**产出**: pmoEngine.js (~200 行), agents.js diff (~80 行), pmo.md (~80 行)

---

### Phase 5: 决策升级链 → PM

**文件**: `claudes/全栈架构师_PM-A1/CLAUDE.md` (改), `lib/agentBus/notifications.js` (改)

**内容**:
- [ ] PM CLAUDE.md: 三级升级链指令 + 决策权重调整
- [ ] `notifications.js`: 升级链 SSE 事件推送

**产出**: CLAUDE.md diff (~40 行), notifications.js diff (~30 行)

---

### Phase 6: Sleep/Wake 管理 → 平台集成工程师-A4

**文件**: `lib/agentBus/sleepManager.js` (新), `routes/agents.js` (改)

**内容**:
- [ ] `sleepManager.js`: `/compact` 注入 + 5min 定时器 + 自动 `check_inbox` 唤醒
- [ ] 权限控制: PM→worker, PMO→PM
- [ ] `routes/agents.js`: `POST /api/agents/sleep` 端点

**产出**: sleepManager.js (~120 行), agents.js diff (~40 行)

---

### Phase 7: 测试 → 可靠性工程师-A2

**文件**: `tests/dag-*.test.js` (新系列)

**内容**:
- [ ] DAG Store 单元测试 (校验规则、循环依赖)
- [ ] 任务状态机测试 (权限矩阵、状态转换)
- [ ] DAG 引擎测试 (依赖解锁、完成判断)
- [ ] PMO 轮询 E2E 测试
- [ ] Sleep/Wake 生命周期测试
- [ ] 集成测试 (完整 DAG 流程)

**产出**: tests/dag-store.test.js, tests/dag-task-system.test.js, tests/dag-engine.test.js, tests/pmo-engine.test.js

---

## 依赖关系

```
Phase 1 (dagStore) ──→ Phase 2 (taskSystem) ──→ Phase 3 (dagEngine)
                              │                        │
                              └────────────┬───────────┘
                                           ↓
                                     Phase 4 (pmoEngine)
                                     Phase 6 (sleepManager)
                                           │
                              ┌────────────┴───────────┐
                              ↓                        ↓
                         Phase 5 (决策链)        Phase 7 (测试)
```

---

## 沟通规则

1. 每个 Phase 完成后 → 发 send_task 通知 PM
2. 遇到阻塞 → 先在信件系统问 PM，不要自行决策
3. 修改共享文件 → 先 request_file_lock
4. A4 与 PM 有交叉 Phase → 在各自的文件工作，通过信件系统同步
