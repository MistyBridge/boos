# Agent-Bus 全量工具多维分析表 (51 Tools)

> 日期: 2026-08-02 | Sprint 36

---

## 评分说明

| 维度 | 评分标准 |
|------|----------|
| **重要性** | ⭐⭐⭐ 核心 (缺则不可用) / ⭐⭐ 常用 / ⭐ 边缘 |
| **有效性** | ✅ 稳定 / ⚠️ 有已知缺陷 / ❌ 不可用 |
| **延迟** | ⚡<1ms / 🟢<50ms / 🟡<500ms / 🔴<5s |
| **权限** | 🔓无认证 / 🔵Worker / 🟡Supervisor / 🟠PM/PMO / 🔴特殊RBAC |

---

## 一、核心通讯 (Core Messaging) — 12 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 1 | **`register_agent`** | 🔓 | ⭐⭐⭐ | ✅ | 🟡 | Agent 注册/重连。设置 ctx.uid + workspace，后续所有操作的前置依赖。重连时自动拿回积压任务数 | 写 identity_card + PG upsert + 心跳注册 + 重连时 PTY 注入 | 唯一零权限工具(设计如此)。cli_session_id = 永久 UID |
| 2 | **`deregister_agent`** | 🔵 | ⭐ | ✅ | 🟢 | 注销当前 agent。清除 ctx.uid/workspace，从 registry 移除 | 解绑 session + 移除 registry 记录 | 极少使用；session 解绑是 fire-and-forget |
| 3 | **`list_agents`** | 🔵 | ⭐⭐⭐ | ✅ | 🟢 | 查看 workspace 在线 agent 列表。Worker 只能看到同 project 的 agent | 纯读 | 每次协作前必调用以确认目标在线 |
| 4 | **`send_task`** | 🔵 | ⭐⭐⭐ | ✅ | 🟡 | 向指定 agent 发送任务(FIFO 队列)。支持 capability 自动路由、跨 project 拦截、reply_to 线程链 | 文件锁写 inbox + SSE 推送 + PTY 注入 + auto-wake | **核心通讯链路**。实测 PM→A3: ~26s 往返 |
| 5 | **`check_inbox`** | 🔵 | ⭐⭐⭐ | ✅ | 🟡 | 从 FIFO 收件箱拉取最旧 pending 任务。取走后状态变为 in_progress | 文件锁出队 + 任务领取事件 | agent 工作循环入口。新版不收 wait/timeout_ms 参数 |
| 6 | **`cancel_task`** | 🔴 | ⭐⭐ | ✅ | 🟡 | 取消自己发的 pending 任务。Supervisor 可取消任意 pending 任务 | 从接收方队列移除 | 仅 sender/supervisor 可调用 |
| 7 | **`interrupt_task`** | 🔴 | ⭐⭐ | ✅ | 🟡 | 中断 in_progress 任务，回收到 pending 队列。Supervisor 可中断任意任务 | 任务状态重置 + inboxEvents 发射 | 用于 agent 崩溃或任务需要重分配 |
| 8 | **`respond_task`** | 🔴 | ⭐⭐⭐ | ✅ | 🟡 | 完成任务并提交结果。仅 receiver 可响应，自动归档到 JSONL | 任务 completed + 归档 + outboxEvents 发射 | Sprint 35 已移除 sync pre-check bug |
| 9 | **`retry_task`** | 🔵 | ⭐⭐ | ⚠️ | ⚡ | 重试 completed/cancelled 任务。最多 3 次，第 4 次标记 exhausted | 任务回 pending + retry_count++ | ⚠️ 仅适用于仍存留在 inbox 的任务，已归档的不可重试 |
| 10 | **`list_my_tasks`** | 🔵 | ⭐⭐ | ✅ | 🟡 | 查看自己的收发任务历史。Supervisor 可查看全 workspace 任务 | 纯读 | Supervisor 视图含 supervisor_view:true 标记 |
| 11 | **`get_task`** | 🔓⚠️ | ⭐ | ⚠️ | ⚡ | 按 task_id 查询任意任务详情 | 纯读 | ⚠️ **零认证**：handler 无 ctx.uid 检查，任何人可查任意 task |
| 12 | **`broadcast`** | 🔵 | ⭐⭐ | ✅ | 🔴 | 向全 workspace 发送广播任务。支持 scope:"project" 限制 | 对 N 个 agent 各写一条任务 + SSE + PTY | 速率限制 10次/60s(内存中，重启丢失) |

---

## 二、Agent 管理 (Agent Management) — 9 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 13 | **`set_pm`** | 🟡 | ⭐⭐ | ✅ | 🟢 | 将 agent 设为某 project 的 PM。空 projects 数组 = 撤销 PM | registry 写 pm_of 字段 | 仅 supervisor 可调用 |
| 14 | **`assign_to_project`** | 🟡 | ⭐ | ✅ | 🟢 | 将 agent 分配到 project | registry 写 project 字段 | Supervisor 或 project PM 可操作 |
| 15 | **`list_agent_cards`** | 🟡 | ⭐⭐ | ✅ | 🔴 | Supervisor 查看全 workspace agent 详情卡片 (含身份、DAG 任务、PTY 状态) | 纯读，但每 agent 做 identityResolver + dagStore + PTY 探测 | 慢但信息全，适合仪表盘 |
| 16 | **`team_matrix`** | 🟡 | ⭐⭐ | ✅ | 🔴 | Supervisor 查看团队矩阵 (含 escalated 计数、活跃任务、sleep 状态) | 纯读，全量扫描 | 最全面的团队快照 |
| 17 | **`kill_worker`** | 🟡 | ⭐ | ✅ | 🟡 | 强制注销 agent，取消其全部任务。不可 kill supervisor 或自己 | 级联取消任务 + 强制移除 registry | 危险操作，无 target 通知 |
| 18 | **`assign_task`** | 🟠 | ⭐ | ⚠️ | 🟡 | PM 直接将任务分配给指定 agent，绕过 capability 匹配 | 文件锁写队列 | ⚠️ 不同于 send_task，不自动 wake——receiver 不会立即感知 |
| 19 | **`list_all_agents`** | 🟡 | ⭐ | ✅ | 🟢 | 列出全 workspace agent (含 role/capabilities/session_count) | 纯读 | 比 list_agents 多含内部字段 |
| 20 | **`wake_agent`** | 🔵 | ⭐⭐⭐ | ✅ | 🟡 | 唤醒指定 agent。SSE 推送 + PTY 终端注入 check_inbox 命令 | SSE + PTY 注入 | Sprint 31 放开权限：任何人都可 wake 同 workspace agent |
| 21 | **`wake_all`** | 🔵 | ⭐⭐ | ✅ | 🔴 | 唤醒全 workspace agent。支持 exclude_self | 串行 SSE + PTY 注入 N 个 agent | 紧急全员通知用 |

---

## 三、DAG 任务系统 — 13 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 22 | **`dag_create`** | 🟠 | ⭐⭐ | ✅ | 🟢 | PM/PMO 创建 DAG 任务图 (draft 状态) | dagStore 写新 DAG | DAG 任务系统入口 |
| 23 | **`dag_add_task`** | 🟠 | ⭐⭐ | ✅ | 🟢 | 向 draft DAG 添加任务节点 (executor + reviewer) | dagStore 写任务节点 | 验证 executor≠reviewer + 无环路 + 依赖存在 |
| 24 | **`dag_activate`** | 🟠 | ⭐⭐ | ✅ | 🟡 | 激活 DAG：所有零依赖任务 → active，派发给 executor | 批量通知 executor | 激活后不可再添加任务 |
| 25 | **`dag_status`** | 🔵 | ⭐⭐ | ✅ | ⚡ | 查看任意 DAG 的任务状态汇总 | 纯读 | 适合仪表盘轮询(由代码层执行) |
| 26 | **`dag_cancel`** | 🟠 | ⭐⭐ | ✅ | 🟢 | 取消整个 DAG，所有未批准任务 → cancelled | 批量状态更新 | executor 不会收到显式通知 |
| 27 | **`dag_submit_task`** | 🔴 | ⭐⭐ | ✅ | 🟢 | Executor 提交任务成果给 reviewer 审批 | taskSystem 写 submitted + content | 仅 executor 可调 |
| 28 | **`dag_approve_task`** | 🔴 | ⭐⭐ | ✅ | 🟡 | Reviewer 批准任务。自动级联解锁下游依赖任务 | 审批 + 级联激活 + 通知下游 executor | DAG 最核心流转操作 |
| 29 | **`dag_reject_task`** | 🔴 | ⭐⭐ | ✅ | 🟢 | Reviewer 驳回任务。累计 retry_count，≥3 次自动 escalate | 退回 executor + 可能 escalate | 需附带 comment 说明原因 |
| 30 | **`dag_my_tasks`** | 🔵 | ⭐⭐ | ✅ | ⚡ | 查看自己作为 executor 或 reviewer 的 DAG 任务 | 纯读 | agent 日常检查自己有哪些 DAG 任务 |
| 31 | **`dag_reassign_task`** | 🟠 | ⭐ | ✅ | 🟢 | PM/PMO 更换任务的 executor/reviewer | taskSystem 更新分配 | escalated 任务 reassign 时自动复位 |
| 32 | **`dag_list`** | 🔵 | ⭐ | ✅ | 🟢 | 列出 workspace 所有 DAG | 纯读 | |
| 33 | **`dag_sleep_agent`** | 🟡 | ⭐ | ✅ | 🟡 | PM/PMO 让 agent 休眠 (/compact)。PM 不可 sleep 另一 supervisor | PTY 注入 /compact + 定时唤醒 | PMO 可 sleep supervisor |
| 34 | **`dag_wake_agent`** | 🔵 | ⭐⭐ | ✅ | 🟡 | 唤醒休眠 agent。Sprint 35 放开为非 PM-only | PTY 注入 check_inbox | 同 workspace 任意 agent 可唤醒他人 |

---

## 四、工作流引擎 (Workflow Engine) — 4 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 35 | **`define_workflow`** | 🟡 | ⭐ | ✅ | 🟢 | Supervisor 定义工作流模板 | workflowEngine 创建 | workflow 系统入口 |
| 36 | **`add_stage`** | 🟡 | ⭐ | ✅ | 🟢 | 向工作流添加阶段节点 (含 capability 要求) | workflowEngine 写节点 | 用于 auto-matching |
| 37 | **`add_dependency`** | 🟡 | ⭐ | ✅ | 🟢 | 定义阶段间依赖边 (有向无环图约束) | workflowEngine 写边 | 仅 draft 状态可添加 |
| 38 | **`activate_workflow`** | 🟡 | ⭐ | ✅ | 🟡 | 激活工作流：零依赖阶段自动派发给匹配 agent | 批量 dispatch N 个 send_task | 每个 stage 注入 [Workflow Stage] 前缀 |

---

## 五、决策与根代理 (Decision & Root) — 2 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 39 | **`request_decision`** | 🔵 | ⭐⭐ | ✅ | 🟢 | Agent 请求人类决策。写入 ~/.boos/decisions/OPEN/ 目录 | 写 .md 文件 + 可选 block 关联任务 | blocking_task_id 可暂停任务等决策 |
| 40 | **`send_to_root`** | 🔵 | ⭐⭐ | ✅ | 🟡 | Agent 向 BOOS Root (人类) 发送消息 | 文件锁写 ROOT_UID 任务 + SSE 推送 | 人类在 Decision Area UI 回复 |

---

## 六、文件锁 (File Lock) — 3 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 41 | **`request_file_lock`** | 🔵 | ⭐⭐ | ✅ | 🟢 | 获取文件排他锁 (5min 自动过期)。受 sandbox 目录边界约束 | 内存锁表 + sandbox 目录检查 | 修改 lib/ 或 server.js 前必须加锁 |
| 42 | **`release_file_lock`** | 🔴 | ⭐⭐ | ✅ | ⚡ | 释放文件锁。Supervisor 可强制释放任意锁 | 内存锁移除 | 仅 lock holder 或 supervisor |
| 43 | **`list_file_locks`** | 🔵 | ⭐ | ✅ | ⚡ | 查看当前所有文件锁 | 纯读 | 调试用 |

---

## 七、知识库 (Knowledge Base) — 2 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 44 | **`update_knowledge`** | 🔵 | ⭐ | ✅ | 🟡 | 写入/追加知识条目到 ~/.boos/knowledge/ | 磁盘写 .md 文件 | 共享知识库，可被其他 agent 搜索 |
| 45 | **`query_knowledge`** | 🔵 | ⭐ | ✅ | 🟡 | 按 path 读取或按 query 全文搜索知识条目 | 磁盘读 | 搜索 O(files × content) |

---

## 八、约束引擎 (Constraints) — 2 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 46 | **`constraints_check`** | 🔵 | ⭐ | ✅ | ⚡ | 检查自己的硬约束 (C5: max 3 in_progress 任务) | 纯读 | 纯建议性 |
| 47 | **`constraints_status`** | 🔵 | ⭐ | ✅ | ⚡ | 查看 workspace 全局约束状态 | 纯读 | 纯建议性 |

---

## 九、BOOS 集成 (BOOS Integration) — 4 tools

| # | 工具 | 权限 | 重要性 | 有效性 | 延迟 | 作用 | 副作用 | 备注 |
|---|------|:--:|:------:|:------:|:--:|------|------|------|
| 48 | **`boos_terminal_list`** | 🔓⚠️ | ⭐ | ⚠️ | 🟡 | 列出所有活跃 PTY 终端 (PID/CLI/CWD/workspace) | 纯读 | ⚠️ **零认证** — 故意忽略 ctx，暴露所有终端信息 |
| 49 | **`boos_list_sessions`** | 🔵 | ⭐ | ✅ | 🟡 | 列出所有 BOOS 会话记录 (含 status/cwd/cliSessionId) | 纯读 | 按 workspace 过滤 |
| 50 | **`boos_get_session`** | 🔵 | ⭐ | ✅ | 🟡 | 获取单个 BOOS 会话详情 (含 PTY 状态 + agent 绑定) | 纯读 | |
| 51 | **`boos_list_workspaces`** | 🔵 | ⭐ | ✅ | 🔴 | 列举工作区目录及 git repo 克隆状态 | 纯读，但需枚举文件系统 | 最慢的只读操作 |

---

## 十、汇总统计

### 按权限

| 级别 | 数量 | 占比 |
|------|:----:|:----:|
| 🔓 零认证 | 3 | 6% |
| 🔵 Worker | 25 | 49% |
| 🟡 Supervisor | 12 | 24% |
| 🟠 PM/PMO | 5 | 10% |
| 🔴 特殊 RBAC | 6 | 12% |

### 按重要性

| 级别 | 数量 | 工具 |
|------|:----:|------|
| ⭐⭐⭐ 核心 | 5 | register_agent, list_agents, send_task, check_inbox, respond_task, wake_agent |
| ⭐⭐ 常用 | 26 | cancel_task, interrupt_task, retry_task, list_my_tasks, broadcast, wake_all, 全部 DAG 工具, 决策工具, 文件锁, dag_wake_agent |
| ⭐ 边缘 | 20 | 管理工具, workflow, 知识库, 约束引擎, BOOS 集成 |

### 按有效性

| 状态 | 数量 | 工具 |
|------|:----:|------|
| ✅ 稳定 | 47 | 92% |
| ⚠️ 有缺陷 | 4 | get_task(零认证), boos_terminal_list(零认证), assign_task(不自动wake), retry_task(已归档不可重试) |

### 按延迟

| 级别 | 数量 | 适合场景 |
|------|:----:|----------|
| ⚡ INSTANT (<1ms) | 8 | 高频查询、仪表盘轮询 |
| 🟢 FAST (<50ms) | 15 | 写操作、轻量读取 |
| 🟡 MODERATE (<500ms) | 19 | 核心通讯(文件锁/SSE/PTY) |
| 🔴 SLOW (<5s) | 5 | 全量报告、批量通知 |

### 按副作用

| 类型 | 数量 | 说明 |
|------|:----:|------|
| 📖 纯读 | 17 | 可安全高频调用 |
| ✏️ 写入本地 | 20 | 持久化变更 |
| 📡 网络推送 | 13 | SSE + PTY 终端注入 |
