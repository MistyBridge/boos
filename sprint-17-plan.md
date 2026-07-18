# Sprint 17 — 计划与追踪

> 开始时间: 2026-07-16 12:45 | PM: 全栈架构师
> 测试基线: **292 pass / 0 fail** (npm test)
> BOOS: port 7780, PID 39548, v1.0.1

## 任务分配

### 平台集成工程师 (agent_mrjzch5f_lagl4z)

| # | 任务 | 优先级 | Task ID | 状态 |
|---|------|:--:|---------|:--:|
| 1 | 死代码清理 + handlers.js readFileSync 修复 | P1 | task_mrnibhb3_nipdsa | 🔄 |
| 2 | TOCTOU 文档 + 安全审计 | P1 | task_mrni4yv2_vot3m9 | 🔄 |
| 3 | sandbox.js ID 冗余分析 | P2 | task_mrni526r_akialp | 🔄 |
| 4 | _syncLoad 迁移评估 (已修正: 无需迁移) | P1 | task_mrni4u7u_5zznak | 🔄 |

### 可靠性工程师 (agent_mrj7km0m_gres6q)

| # | 任务 | 优先级 | Task ID | 状态 |
|---|------|:--:|---------|:--:|
| 1 | 回归测试 + agent-bus 负载测试 (#82) | P3 | task_mrni575a_dr8fnr | 🔄 |
| 2 | 前端渲染性能基线 (B4) | - | task_mrnapcbx_mjfkgu | ✅ |

### 前端工程师 (agent_mrj7kjfv_k5ze3t)

| # | 任务 | 优先级 | Task ID | 状态 |
|---|------|:--:|---------|:--:|
| - | 唤醒回路验证 | - | task_mrnbmd9s_sp94ed | ✅ |
| - | A4-A6 + B1-B3 前端任务 | - | - | 🔄 (进行中) |

## PM 自主发现 (本 session)

### 代码审计结果

1. **`countInProgressTasks` 是死代码** — store.js:813-818 定义并导出，全局零调用
2. **handlers.js 直接 readFileSync 绕过 store 抽象** — 第 364/369 行在 `_listMyTasks` 中直接读 `store.DB_PATH`
3. **sandbox.js ID 冗余** — `_allAgentIds()` 和 `_resolveFolderId()` 重复执行相同的 lookup 链 (transportSid → identity → resolver)
4. **所有 `_syncLoad` 调用方都是只读的** — 无 TOCTOU 风险，无需迁移为 async

### Stale 任务清理

以下历史任务需要清理:
- Sprint 11/16 broadcast 测试 → 5 个 pending 给 unresponsive agents (通用助手/HR/QuantDev)
- Sprint 16 平台集成 5-task 分配 → 7 个 exhausted/in_progress
- root-inbox 测试 → 3 个 in_progress 给 agent_root (永远不会有响应)

## 待办

- [ ] 等待团队响应 (预计 5-10 min)
- [ ] 审查平台集成的安全审计报告
- [ ] 审查可靠性工程师的负载测试结果
- [ ] 清理 stale 任务
- [ ] 更新 CLAUDE.md 记录 Sprint 17 进度
