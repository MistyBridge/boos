# Sprint 22: 统一原子身份索引

> **目标**: 彻底解决 Agent-Bus 团队内成员无法正确索引的问题
> **日期**: 2026-07-26
> **状态**: in_progress

---

## 问题诊断

### 六大根因

| # | 根因 | 严重度 |
|---|------|:--:|
| 1 | `identity_by_mcp_session` 索引只在 `bindMcpSession()` 维护，但注册流程从不调用它 → 索引永远为空 | 🔴 P0 |
| 2 | `_register()` 一次注册做 4 次独立 `withFileLock` → 中间状态对外可见 | 🔴 P0 |
| 3 | `_findSessionByUid()` 有 5 层 12 级 fallback — 系统不信任自己的主路径 | 🟡 P1 |
| 4 | `db.sessions` 和 `persistedSessions` 是两套独立的 session 表，通过 identity card 间接关联 | 🟡 P1 |
| 5 | `resolveBoosSessionForAgent()` 和 `findByAgentName()` 依赖 cwd/title/workspace 启发式匹配 | 🟡 P1 |
| 6 | `__pending__` sentinel 值被写入 `identity_by_boos_session` 反向索引，污染索引 | 🟠 P2 |

### 核心矛盾

Session spawn 和 agent register 是两个独立事件。当前模型是"agent 注册时事后找 session"——永远有窗口期是错的。

---

## 方案设计

### 核心思路

**Session 路由绕过 identity card，直接走 `persistedSessions.agentUid`。**

```
改前:
  agent_uid → identity card → boos_session_id → persistedSessions.find()
                        ↑ 4 层 fallback 修补这个间接查找的不可靠性

改后:
  agent_uid → persistedSessions.find(s => s.agentUid === uid)
                        ↑ 一次直接查找，零 fallback
```

Identity card 职责收窄为 MCP 重连恢复，不再承担 session 路由。

### 三个变更支柱

```
支柱 A: persistedSessions 加 agentUid 字段
  → session spawn 时直接声明归属
  → 热路径 _findSessionByUid 变成一次直接 lookup

支柱 B: writeIdentity() 统一原子写入
  → 替代 upsertIdentity / linkIdentityToSession / bindMcpSession / unbindMcpSession / onSessionExited
  → 一把锁内更新 identity card + 全部三个反向索引（含 identity_by_mcp_session）

支柱 C: 删除所有启发式 fallback
  → 删除 _findSessionByUid 的 Pass 1.5/2/3
  → 删除 persistedSessions.findByAgentName()
  → 删除 resolveBoosSessionForAgent() 的 Pass 2/3/4
  → 删除所有 __pending__ sentinel 逻辑
```

---

## 实施阶段

### Phase 1: Store 层 — `writeIdentity()` 统一原子写

**负责**: 全栈架构师 (PM)
**文件**: `lib/agentBus/store.js`

**任务**:
1. 新增 `writeIdentity(agentUid, fields)` — 一个 `withFileLock` 内完成:
   - 合并 identity card 字段
   - 原子更新 `identity_by_boos_session` 索引
   - 原子更新 `identity_by_mcp_session` 索引 ← **修复核心 gap**
   - 原子更新 `identity_by_name_ws` 索引
2. 新增 `rebuildAllIndices()` — 启动时从 identity cards 全量重建三个索引（不依赖启发式）
3. 标记旧函数 `@deprecated`: `upsertIdentity`, `linkIdentityToSession`, `bindMcpSession`, `unbindMcpSession`, `onSessionExited`

**验收**:
- `identity_by_mcp_session` 在 writeIdentity 调用后立即可查
- 三个索引对同一 agentUid 返回一致结果
- 旧函数仍可用但标注废弃

### Phase 2: Session 层 — `agentUid` 字段

**负责**: 全栈架构师 (PM)
**文件**: `lib/persistedSessions.js`

**任务**:
1. session schema 新增 `agentUid` 字段（可选，向后兼容）
2. 新增 `update(id, fields)` 方法 — 原子更新 session 记录的任意字段
3. session create 时接受 `agentUid` 参数

**验收**:
- 新 session 可携带 agentUid
- 旧 session（无 agentUid）不受影响
- `loadAll()` 返回的记录含 agentUid 字段

### Phase 3: 热路径简化 — `_findSessionByUid` 直接查找

**负责**: 平台集成工程师
**文件**: `lib/agentBus/notifications.js`

**任务**:
1. `_findSessionByUid(uid)` 改为:
   ```js
   const all = await persistedSessions.loadAll();
   const match = all.find(s => s.agentUid === uid && s.status === 'running');
   if (match && webTerminal.get(match.id)?.exitedAt == null) return match;
   return null;
   ```
2. 删除 Pass 0 (IdentityResolver), Pass 1 (identity card), Pass 1.5 (auto-heal), Pass 2 (name+ws), Pass 3 (findByAgentName)
3. `_findSession()` 同样简化

**验收**:
- 热路径从 ~50 行减少到 ~5 行
- 任务投递仍然正确找到目标 session
- 无启发式匹配参与

### Phase 4: 调用方迁移

**负责**: 平台集成工程师
**文件**: `lib/agentBus/handlers.js`, `lib/agentBus/transport.js`

**任务**:
1. `_register()`: 合并 4 次独立写为 1 次 `writeIdentity()` 调用
2. `_launchAgentSession()` + `_internalLaunchAgentSession()`: 
   - session spawn 后立即写 `agentUid` 到 persistedSessions
   - `linkIdentityToSession` → `writeIdentity`
3. `transport.js`: `upsertIdentity` → `writeIdentity`

**验收**:
- `_register` 只做一次 withFileLock 写操作
- session spawn 后 agentUid 立即可查
- MCP 重连时 mcp_session_id 索引自动更新

### Phase 5: 清理 — 删除死代码

**负责**: 平台集成工程师
**文件**: `lib/agentBus/store.js`, `lib/persistedSessions.js`

**任务**:
1. `store.resolveBoosSessionForAgent()` 删除 Pass 2/3/4（保留 Pass 1 identity card lookup）
2. `persistedSessions.findByAgentName()` 标记 `@deprecated` 或在所有调用方迁移后删除
3. 删除 `__pending__` sentinel 所有写入和检查逻辑
4. 启动时调用 `rebuildAllIndices()` 替代 `bootstrapIdentities()` 中的启发式匹配

**验收**:
- 无 `__pending__` 写入反向索引
- 无 cwd basename / title / workspace 启发式匹配
- `npm test` 零回归

### Phase 6: 测试 + 端到端验证

**负责**: 可靠性工程师
**范围**: 全链路验证

**任务**:
1. 单元测试: `writeIdentity` 三个索引同步
2. 单元测试: `_findSessionByUid` 直接 lookup
3. 集成测试: agent register → session spawn → 任务投递
4. 回归测试: `npm test` 全部通过
5. 手动验证: 
   - 重启 BOOS → agent 重连 → identity card 正确恢复
   - send_task → wake_agent → agent 收到任务

**验收**:
- 294+ 测试全部通过
- 任务在 agent 间正常投递
- 重启后 MCP 重连不需要重新 register

---

## 文件变更总览

| 文件 | 变更类型 | 预估行数 | 负责人 |
|------|---------|---------|--------|
| `lib/agentBus/store.js` | 新增 writeIdentity + rebuildAllIndices | +80 | PM |
| `lib/agentBus/store.js` | 标记 5 函数 deprecated | +30 | PM |
| `lib/persistedSessions.js` | 加 agentUid + update() | +25 | PM |
| `lib/agentBus/notifications.js` | _findSessionByUid 简化 | -45 +5 | 平台集成 |
| `lib/agentBus/handlers.js` | _register 合并写 | -25 +8 | 平台集成 |
| `lib/agentBus/handlers.js` | session spawn 写 agentUid | 6 处各 1 行 | 平台集成 |
| `lib/agentBus/transport.js` | upsertIdentity → writeIdentity | 2 处替换 | 平台集成 |
| `lib/agentBus/store.js` | 删 resolveBoosSessionForAgent Pass 2-4 | -25 | 平台集成 |
| `lib/persistedSessions.js` | 删 findByAgentName | -50 | 平台集成 |
| `tests/` | 新增 + 回归 | +60 | 可靠性工程师 |

---

## 依赖关系

```
Phase 1 (writeIdentity) ──┐
                           ├── Phase 4 (调用方迁移) ── Phase 5 (清理)
Phase 2 (agentUid 字段) ──┤                                        │
                           ├── Phase 3 (热路径简化) ────────────────┘
                           │                                        │
                           └── Phase 6 (测试验证) ◄─────────────────┘
```

Phase 1 和 Phase 2 无依赖，可并行。
Phase 3 依赖 Phase 2。
Phase 4 依赖 Phase 1。
Phase 5 依赖 Phase 3 + Phase 4。
Phase 6 依赖全部。

---

## 验收标准

1. `identity_by_mcp_session` 索引在任意 agent 注册后立即可用
2. `_findSessionByUid()` 从 ~50 行减少到 ~5 行，零 fallback
3. 所有启发式 session 查找（cwd/title/workspace/fuzzy）已删除
4. `__pending__` sentinel 值不再出现在任何反向索引中
5. Agent 重启/MCP 重连后，identity card 自动恢复，无需重新 register
6. `npm test` 零回归
7. 任务投递成功率 100%（在 agent 在线的前提下）

---

*创建: 2026-07-26 · Sprint 22*
