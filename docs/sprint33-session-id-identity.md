# Sprint 33: Session ID 统一身份系统

> **状态**: 实施中 | **日期**: 2026-07-30 | **作者**: 全栈架构师_PM-A1

---

## 1. 问题陈述

### 当前身份系统的混乱

BOOS Agent-Bus 当前存在 **4 层身份映射**，每一层都可能断裂：

```
┌─ Agent 注册 ─────────────────────────────────────────────────┐
│  register_agent("PM", "boos")                                  │
│      ↓                                                         │
│  uid = "agent_5tJxrPyDOErB"  (SHA256 hash of name+workspace)   │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ Identity Card 桥接 ────▼─────────────────────────────────────┐
│  storeIdentity.writeIdentity(uid, {                            │
│      boos_session_id: "sess-mrjzbzfs-zv1bm9",                  │
│      mcp_session_id:  "mcp_abc123...",                         │
│  })                                                            │
│  Reverse indices:                                              │
│    identity_by_boos_session["sess-xxx"] → uid                  │
│    identity_by_mcp_session["mcp_xxx"]   → uid                  │
│    identity_by_name_ws["PM|boos"]       → uid                  │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ Session Record ─────────▼─────────────────────────────────────┐
│  sessions.json: { "sess-mrjzbzfs-zv1bm9": { agentUid: "..." } }│
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ Wake/Lookup (3-path fallback) ─▼─────────────────────────────┐
│  Path 1: s.agentUid === uid                                    │
│  Path 2: identity.boos_session_id → session lookup             │
│  Path 3: agent.name → session.title/workspace/cwd fuzzy match  │
│    (with auto-backfill to agentUid)                             │
└────────────────────────────────────────────────────────────────┘
```

**问题**:
1. 一个 BOOS session 可注册多个 agent-bus 账号 → 身份混乱
2. 4 层映射全部断裂时需要 3-path fallback → `notificationsWake.js` 300+ 行 lookup 逻辑
3. `agent_xxx` 格式与 session ID 格式不同 → 所有路由需要桥接
4. CLAUDE.md 中硬编码的 `agent_xxx` 在 session 重启后可能失效

---

## 2. 目标架构

### 核心原则

> **Session ID 是唯一身份标识。所有鉴权、路由、权限查询都走 session ID。**

```
┌─ PTY Session ────────────────────────────────────────────┐
│  BOOS spawns Claude in PTY                                │
│  sessionId = "sess-mrjzbzfs-zv1bm9"                       │
│  ↓                                                        │
│  BOOS injects .mcp.json:                                   │
│    agent-bus URL = /mcp/sse?boos_session_id=sess-xxx      │
└────────────────────────┬──────────────────────────────────┘
                         │
┌─ MCP SSE Connection ───▼──────────────────────────────────┐
│  transport.js captures ctx.boosSessionId = "sess-xxx"      │
└────────────────────────┬──────────────────────────────────┘
                         │
┌─ Registration ─────────▼──────────────────────────────────┐
│  register_agent("PM", "boos")                              │
│  → uid = ctx.boosSessionId = "sess-mrjzbzfs-zv1bm9"       │
│  → 1 session = 1 agent (enforced)                          │
│  → name is metadata only, NOT a routing key                │
└────────────────────────┬──────────────────────────────────┘
                         │
┌─ All Operations ───────▼──────────────────────────────────┐
│  send_task(to_uid="sess-xxx")  → direct route              │
│  wake_agent(target_uid="sess-xxx") → webTerminal.get(uid)  │
│  get_permissions(uid) → lookup by session ID               │
│                                                            │
│  ZERO mapping. ZERO fallback paths.                        │
└────────────────────────────────────────────────────────────┘
```

### 特殊 ID

| ID | 用途 | PTY |
|----|------|:--:|
| `sess-*` | 普通 Agent（含 HR Agent） | ✅ |
| `__root__` | 人类用户在 Agent-Bus 中的代号，路由到 BOOS 决策区 | ❌ |

---

## 3. 鉴权体系

### 3.1 全平台统一鉴权入口

所有鉴权操作均接受 `sessionId` 作为主体标识：

```
                    ┌─────────────────────┐
                    │   sessionId          │
                    │   (sess-mrjzb...)    │
                    └─────────┬───────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │  Agent-Bus   │   │  Filesystem  │   │  Workspace   │
   │  Auth        │   │  (Sandbox)   │   │  Config      │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │                   │                   │
          ▼                   ▼                   ▼
   ┌──────────────────────────────────────────────────────┐
   │              Session Permissions Store                │
   │                                                      │
   │  sessionId → {                                        │
   │    agent: { name, role, workspace, capabilities },    │
   │    folder: { id, rootPath, agentLevels, writeExts }, │
   │    sandbox: { allowedDirs, writeExtensions },         │
   │    workspace: { autoSupervisor, ... },                │
   │  }                                                    │
   └──────────────────────────────────────────────────────┘
```

### 3.2 Agent-Bus 鉴权

```javascript
// 所有 MCP handler 的鉴权入口
function auth(ctx) {
  const uid = ctx.uid;               // === sessionId
  const agent = store.getAgent(uid); // O(1) lookup by session ID
  return {
    uid,
    name: agent.name,                // 仅用于展示
    role: agent.role,                // worker | supervisor | pmo | root
    workspace: agent.workspace,
    capabilities: agent.capabilities,
  };
}

// 权限检查
function requireRole(ctx, role) {
  const a = auth(ctx);
  if (a.role !== role) throw new AuthError(...);
  return a;
}

function requireSupervisor(ctx) {
  return requireRole(ctx, 'supervisor');
}

function requirePM(ctx, project) {
  const a = auth(ctx);
  if (!store.isPMOf(a.uid, project)) throw new AuthError(...);
  return a;
}
```

### 3.3 Filesystem 鉴权 (Sandbox)

```javascript
// lib/sandbox.js — all sandbox checks use sessionId directly

async function isAllowed(sessionId, filePath) {
  // 1. Look up folder by session ID
  const folderId = await _resolveFolderId(sessionId);
  
  // 2. Get folder config (rootPath, write extensions, agent levels)
  const folder = await folders.findById(folderId);
  
  // 3. Check path within rootPath
  if (!isWithin(folder.rootPath, filePath)) return { allowed: false };
  
  // 4. Check agent level (PM/PMO/SE gating)
  const agent = store.getAgent(sessionId);
  const level = folder.agentLevels?.[agent.role];
  if (!level) return { allowed: false };
  
  return { allowed: true, level, writeExtensions: folder.writeExtensions };
}

async function getWritePermission(sessionId) {
  const folder = await _resolveFolder(sessionId);
  return folder?.codeWriteEnabled !== false;
}

async function getFilesystemMcpConfig(sessionId) {
  const folder = await _resolveFolder(sessionId);
  const hasWrite = await getWritePermission(sessionId);
  return {
    command: 'node',
    args: [
      MCP_SERVER_PATH,
      folder.rootPath,
      ...(hasWrite ? [] : ['--write-extensions=.md,.txt,.json,.yaml,.yml,.toml']),
    ],
  };
}
```

### 3.4 鉴权查询 API

```javascript
// 统一权限查询接口
// GET /api/auth/permissions?sessionId=sess-xxx
// 或通过 agent-bus MCP: constraints_check

async function getSessionPermissions(sessionId) {
  const agent = store.getAgent(sessionId);
  if (!agent) return { error: 'not registered' };

  const folderId = await sandbox._resolveFolderId(sessionId);
  const folder = folderId ? await folders.findById(folderId) : null;

  return {
    sessionId,
    agent: {
      name: agent.name,
      role: agent.role,
      workspace: agent.workspace,
      capabilities: agent.capabilities,
      project: agent.project,
    },
    folder: folder ? {
      id: folder.id,
      name: folder.name,
      rootPath: folder.rootPath,
      agentLevels: folder.agentLevels || {},
      codeWriteEnabled: folder.codeWriteEnabled !== false,
      autoSupervisorEnabled: folder.autoSupervisorEnabled !== false,
    } : null,
    sandbox: {
      allowedDirectories: folder ? [folder.rootPath] : [],
      writeExtensions: folder?.codeWriteEnabled !== false
        ? [] // all allowed
        : ['.md', '.txt', '.json', '.yaml', '.yml', '.toml'],
    },
  };
}
```

---

## 4. 关键流程

### 4.1 Agent 注册流程

```
1. BOOS spawnSessionRecord()
   ├─ 写入 .mcp.json: agent-bus URL += "?boos_session_id={sessionId}"
   └─ 启动 Claude PTY

2. Claude Code 启动
   ├─ 读取 .mcp.json → 连接 agent-bus MCP SSE
   └─ URL 自带 boos_session_id 参数

3. transport.js GET /sse
   ├─ ctx.boosSessionId = req.query.boos_session_id
   └─ ctx.uid = boosSessionId  (预填充)

4. Agent 调用 register_agent(name, workspace, role, ...)
   ├─ registry.registerAgent({ sessionId, name, workspace, role })
   ├─ 检查: sessionId 已有 agent? → reconnect 返回已有 uid
   ├─ 否则: uid = sessionId (不是 agent_xxx hash)
   └─ 写入 identity card (uid === boosSessionId, 跳过反向索引)

5. 返回 { uid: "sess-mrjzbzfs-zv1bm9", name: "PM", ... }
```

### 4.2 任务路由流程

```
发送方: send_task(to_uid="sess-receiver-xxx", content="...")
  ├─ store.getAgent("sess-receiver-xxx") → O(1) session ID lookup
  ├─ queue.sendTask({ receiver_uid: "sess-receiver-xxx" })
  └─ wakeAgent("sess-receiver-xxx")
       ├─ webTerminal.get("sess-receiver-xxx") → O(1)
       └─ PTY write("check_inbox\r")

接收方: check_inbox()
  └─ queue.checkInbox(ctx.uid) → 直接 uid === sessionId
```

### 4.3 Wake Agent 流程

```
旧: wakeAgent(uid)
  → _findSessionByUid(uid)  ← 3-path fallback, ~40 行
  → _findAnySessionByUid(uid) ← 4-path fallback, ~30 行
  → auto-resume fallback ← 额外 30 行

新: wakeAgent(uid)
  → webTerminal.get(uid)  ← 1 行, O(1)
  → 如果 PTY 不在运行 → autoResumeSession(uid) ← 保留
```

---

## 5. 数据迁移

### 5.1 迁移策略

```
Phase 1 (并行): 新 agent 用 session ID，旧 agent 保持 agent_xxx
  - registry.js: sessionId 存在 → uid = sessionId
  - registry.js: sessionId 不存在 → uid = agent_xxx (legacy)
  - store.js: uid 可以是任意字符串 (本来就支持)

Phase 2 (迁移): 将旧 agent 迁移到 session ID
  - 扫描 agent-bus-store.json 中的 agents
  - 对每个 agent_xxx uid:
    1. 查找对应的 BOOS session ID (identity card)
    2. 调用 store.migrateAgentUid(oldUid, sessionId)
    3. 更新 tasks 中的 sender_uid/receiver_uid
    4. 更新 DAG 中的 executor_uid/reviewer_uid

Phase 3 (清理): 移除 agent_xxx 生成逻辑
  - _generateUid() → deprecated
  - identity card 的 boos_session_id 反向索引 → 简化
```

### 5.2 迁移脚本

```javascript
// scripts/migrate-to-session-id.js
async function migrate() {
  const db = store._syncLoad();
  let migrated = 0;

  for (const [uid, agent] of Object.entries(db.agents)) {
    if (uid.startsWith('sess-')) continue; // already migrated

    // Find BOOS session for this agent
    const identity = db.identities[uid];
    const boosSessionId = identity?.boos_session_id;
    if (!boosSessionId) {
      console.warn(`[migrate] no session for ${uid} (${agent.name}), skipping`);
      continue;
    }

    console.log(`[migrate] ${uid} → ${boosSessionId} (${agent.name})`);
    const result = await store.migrateAgentUid(uid, boosSessionId);
    if (result.ok) migrated++;
  }

  console.log(`[migrate] done: ${migrated} agents migrated`);
}
```

---

## 6. 文件变更清单

### 已完成 ✅ (Sprint 33 Phase 1 — all 12 files)

| 文件 | 变更 | 行数 |
|------|------|:--:|
| `lib/agentBus/transport.js` | 捕获 `boos_session_id` 查询参数 | +6 |
| `lib/sessionHelpers.js` | Managed agent spawn 前注入 `.mcp.json` | +22 |
| `lib/agentBus/registry.js` | `registerAgent()` 接受 `sessionId`，强制 1:1 | +20 |
| `lib/agentBus/handlers.js` | `_register()` 传递 session ID | +10 |
| `lib/agentBus/notificationsWake.js` | `_findSessionByUid` 快速路径 (O(1)) | -40 |
| `lib/agentBus/storeIdentity.js` | 简化解析 + 反向索引优化 | +8 |
| `lib/agentBus/autoSupervisor.js` | Folder 查找优先 session ID | +6 |
| `lib/identityResolver.js` | 兼容 session ID 格式 (sess- 快速路径) | +15 |
| `lib/sandbox.js` | `_resolveFolderId` session ID 快速路径 (O(1)) | +5 |
| `lib/agentBus/handlersSession.js` | `_requestFileLock` 鉴权链: session ID → agent → sandbox → write | +9 |
| `lib/workspaceConfig.js` | `getSessionPermissions(sessionId)` 统一权限查询入口 | +72 |
| `routes/workspaceConfig.js` | `GET /api/auth/permissions?sessionId=` 鉴权 API | +11 |

### 待完成 ⏳ (P2)

| 文件 | 变更 | 优先级 |
|------|------|:--:|
| `lib/agentBus/schemas.js` | `to_uid`/`target_uid` 描述更新为 session ID | P2 |
| `lib/agentBus/schemasDag.js` | `executor_uid`/`reviewer_uid` 描述更新 | P2 |
| `scripts/migrate-to-session-id.js` | 数据迁移脚本 | P2 |
| `claudes/**/CLAUDE.md` | 硬编码 UID → session ID | P2 |
| Agent `.mcp.json` 文件 | 更新 agent-bus URL (含 `?boos_session_id=`) | P2 |
| 单元测试 | registry / notificationsWake / storeIdentity / sandbox / identityResolver | P2 |

### 可删除/简化

| 项目 | 原因 |
|------|------|
| `notificationsWake.js:_findSessionByUid()` Path 3 (name match) | session ID 就是 PTY key |
| `notificationsWake.js:_findAnySessionByUid()` Path 3 (name fallback) | 同上 |
| `storeIdentity.js:identity_by_boos_session` 反向索引 | uid === session ID 时不需桥接 |
| `persistedSessions.agentUid` 字段 | 不再需要 |
| `persistedSessions.setAgentUid()` | 不再需要 backfill |

---

## 7. 约束规则

### 硬约束

| # | 规则 | 强制位置 |
|---|------|----------|
| 1 | 每个 BOOS session 只能注册 1 个 agent-bus 账号 | `registry.js` |
| 2 | Agent uid 必须 == BOOS session ID | `handlers.js:_register()` |
| 3 | `name` 仅用于展示，不作为路由参数 | 所有 handler |
| 4 | `ROOT` 使用 `__root__` 特殊 ID，路由到决策区 | `handlersSession.js:_sendToRoot()` |
| 5 | 所有鉴权入口接受 `sessionId` | `sandbox.js`, `handlersSession.js` |
| 6 | 权限查询通过 session ID → folder → config 链路 | `workspaceConfig.js` |

### 软约束

| # | 规则 |
|---|------|
| 7 | 向后兼容：旧 `agent_xxx` format 仍可用（legacy path） |
| 8 | MCP 工具参数名不变（`to_uid`、`target_uid`），值改为 session ID |
| 9 | 无 session ID 的 MCP 连接 → 自动注册为 worker（auto-resolve） |

---

## 8. 测试计划

### 单元测试

| 模块 | 测试内容 | 状态 |
|------|----------|:--:|
| `registry.test.js` | sessionId 注册 + 1:1 强制 + reconnect | ⏳ |
| `notificationsWake.test.js` | 快速路径: `webTerminal.get(uid)` 直接命中 | ⏳ |
| `storeIdentity.test.js` | uid === sessionId 时跳过反向索引 | ⏳ |
| `sandbox.test.js` | `_resolveFolderId(sessionId)` | ⏳ |
| `identityResolver.test.js` | session ID 格式解析 | ⏳ |

### 集成测试

| 场景 | 步骤 |
|------|------|
| 注册→路由→唤醒 | `register_agent` → `send_task` → `check_inbox` → `respond_task` → PM 收到通知 |
| 1:1 强制 | 同一 session 两次 `register_agent` → 第二次返回已有 uid |
| Legacy 兼容 | `agent_xxx` uid 仍可通过 identity card 路由 |

### 回归测试

- 现有 86 个 agent-bus/DAG/identity/schema 测试全部通过 ✅ (2026-07-30)
- 遗留测试修复: `wake_all` 描述断言不再要求 `supervisor` ✅

---

## 9. 变更前后对比

| 维度 | 旧 | 新 |
|------|----|----|
| 身份标识 | `agent_5tJxrPyDOErB` (hash) | `sess-mrjzbzfs-zv1bm9` (session ID) |
| 身份映射 | 4 层 (agent → identity → session → PTY) | 0 层 |
| Session 查找 | 3-path fallback (~40 行) | `webTerminal.get(uid)` (1 行) |
| 多账号/会话 | 允许（混乱来源） | 禁止（强制 1:1） |
| 鉴权入口 | `ctx.uid` → identity card → session | `ctx.uid` → session ID 直接查 |
| MCP 工具参数 | `to_uid: "agent_xxx"` | `to_uid: "sess-xxx"` (格式变化) |
| 权限查询 | `sandbox.isAllowed(ctx.uid, path)` → multi-step | `_resolveFolderId(sessionId)` → 2-step |
| Backfill | `persistedSessions.setAgentUid()` | 不需要 |
| Identity card | 必需（桥接 uid↔session） | 简化（元数据存储） |

---

*最后更新: 2026-07-30 · Sprint 33 Plan*
