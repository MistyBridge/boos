# Agent-Bus 安全审查报告

**审查日期**: 2026-07-13  
**审查人**: 可靠性工程师  
**范围**: `lib/agentBus/transport.js`, `lib/agentBus/handlers.js`, `lib/agentBus/queue.js`, `lib/agentBus/store.js`, `lib/agentBus/registry.js`, `lib/agentBus/schemas.js`, `lib/agentBus/notifications.js`, `lib/agentBus/workspace.js`  
**版本**: agent-bus v2.1 (embedded in BOOS)

---

## 执行摘要

**总体评级: ⚠️ 中等风险** — Agent-Bus 有良好的基础安全设计（跨 workspace 隔离、sender-only 权限控制、内容长度截断），但在 **session 认证**、**SSE 注入** 和 **速率限制** 方面存在可修复的缺陷。

| 类别 | 风险等级 | 问题数 |
|------|---------|--------|
| Session 认证 | 🔴 高 | 2 |
| 任务注入 | 🟡 中 | 2 |
| 速率限制 | 🟡 中 | 1 |
| 权限模型 | 🟢 低 | 2 |
| 数据安全 | 🟢 低 | 1 |

---

## 1. SSE 端点安全 (`transport.js`)

### 1.1 🔴 sessionId 可预测 — 会话劫持风险

**位置**: `transport.js:92-93`, `store.js:245-248`

```javascript
// GET /sse
const sessionId = req.query.sessionId || _generateSessionId();
```

**问题**: sessionId 可通过 query 参数显式传入。攻击者如果知道目标 agent 的 sessionId，可以直接连接 `/mcp/sse?sessionId=<known>` 接管其 MCP session。

`_generateSessionId()` 使用:
```javascript
function _generateSessionId() {
  return 'mcp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}
```

- `Date.now()` 可预测到毫秒级
- `Math.random()` 不是密码学安全的随机数
- 仅 36^8 ≈ 2.8 万亿种可能组合，在本地回环环境下可被暴力枚举

**影响**: 恶意本地进程可劫持其他 agent 的 SSE session，以该 agent 身份发送/接收任务。

**修复建议**:
```javascript
const crypto = require('node:crypto');
function _generateSessionId() {
  return 'mcp_' + crypto.randomUUID();
}
```
同时加入 session token 机制：`register_agent` 返回 session token，后续请求必须在 header 中携带。

---

### 1.2 🔴 SSE endpoint 无认证 — 任何人可连接

**位置**: `transport.js:92-128`

**问题**: `/mcp/sse` 端点无任何认证机制。任何能访问 BOOS 端口的进程都可以：
1. 连接 SSE 并调用 `register_agent` 注册为任意 agent
2. 发送/接收任务
3. 广播消息到整个 workspace

**当前防御层**: BOOS 只监听 `127.0.0.1`，所以只有本地进程能连接。这在单用户开发机上足够，但无法防御：
- 恶意 npm postinstall 脚本
- 浏览器扩展滥用 localhost 访问
- 共享开发机上的其他用户

**修复建议**:
- 短期: 在 `register_agent` 时生成 session token（crypto.randomUUID），后续请求验证 token
- 中期: 添加 `BOOS_AGENT_BUS_TOKEN` 环境变量，作为预共享密钥
- 长期: 支持 Unix domain socket 权限模型（仅文件所有者可连接）

---

## 2. 任务注入风险 (`queue.js` + `handlers.js`)

### 2.1 🟡 task content 长度限制存在但不足

**位置**: `queue.js:44`, `store.js:162`

```javascript
// queue.js
content: content.slice(0, 4096),

// store.js
content: task.content,
```

**问题**: 
- 4096 字节的内容截断防止了简单 DoS，但没有对内容进行语义验证
- `content` 在 `_toExternal()` 中原样返回，客户端可能将其渲染为 markdown/HTML
- `sender_name` 和 `sender_intro` 仅做了长度截断 (`slice(0, 64)`, `slice(0, 256)`)，未过滤控制字符

**潜在风险**:
- 如果前端将 task content 渲染为 HTML（如 markdown preview），攻击者可注入 `<script>` 或 `<img onerror>` 
- 控制字符注入可能导致终端渲染异常（ANSI escape sequences）

**当前缓解**:
- 长度截断限制了攻击载荷大小
- BOOS 前端目前不渲染 task content 为 HTML

**修复建议**:
```javascript
// 添加内容清洗
function sanitizeContent(str) {
  return str
    .slice(0, 4096)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 移除控制字符（保留 \n \t）
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');             // 移除 ANSI escape
}
```

---

### 2.2 🟡 task_id 由发送方控制 — 潜在冲突和伪造

**位置**: `queue.js:38`

```javascript
task_id: task_id || store.genTaskId(),
```

**问题**: `send_task` 的调用者可以通过 `args.task_id` 指定自定义 task ID。虽然在当前 JSON Schema (`schemas.js:40-45`) 中未暴露此参数（schema 中 `send_task` 只有 `to_uid`, `content`, `priority`），但 handler 层缺少二次验证：

- `_sendTask` handler 直接透传 args 到 `queue.sendTask(args.sender, args.receiver_uid, args.content, args.priority, args.task_id)`
- 如果未来 schema 允许自定义 task_id，或客户端绕过了 schema 校验，攻击者可以:
  - 注入与现有 task 重复的 ID → 覆盖/替换
  - 使用可预测的 ID 进行时序攻击

**修复建议**:
```javascript
// 强制使用服务端生成的 task_id
const task_id = store.genTaskId(); // 始终由服务端生成
```

---

## 3. 速率限制 (`queue.js` + `transport.js`)

### 3.1 🟡 broadcast 无限流 — workspace DoS

**位置**: `queue.js:115-133`, `handlers.js:143-150`

```javascript
function broadcast(workspace, senderUid, message, receiverUids) {
  const targets = receiverUids.filter((uid) => uid !== senderUid);
  for (const receiverUid of targets) {
    const r = sendTask({ sender: ..., content: ... });
  }
}
```

**问题**: 
- **无速率限制**: 任何注册 agent 可以无限制调用 `broadcast`
- **无频率限制**: 可以在循环中调用 broadcast 淹没所有 agent 的收件箱
- **无广播配额**: 每次 broadcast 为 workspace 中每个 agent 创建一个 task
- `inboxEvents.emit('task_available')` 在每个 task 发送时触发，且只限 `0→1` 转换。如果攻击者快速发送大量 task，除第一个外不会触发事件，但 task 仍然在队列中累积

**影响**:
- 收件箱爆炸: 攻击者注册 agent → `broadcast` 1000 次 → 每个 agent 的收件箱有 1000/N 条垃圾任务
- 磁盘膨胀: `agent-bus.json` 中的 tasks 对象无限增长
- 无 task 过期机制: tasks 永不过期删除

**修复建议**:
```javascript
const BROADCAST_RATE_LIMIT = new Map(); // uid → [timestamps]

function checkBroadcastRate(uid) {
  const window = 60_000; // 1 minute
  const limit = 5;       // max 5 broadcasts per minute
  const now = Date.now();
  const timestamps = BROADCAST_RATE_LIMIT.get(uid) || [];
  const recent = timestamps.filter((t) => now - t < window);
  if (recent.length >= limit) return false;
  recent.push(now);
  BROADCAST_RATE_LIMIT.set(uid, recent);
  return true;
}
```

此外，添加 task 自动过期机制（如 7 天后自动清理 completed/cancelled tasks）。

---

## 4. 权限模型 (`handlers.js` + `queue.js`)

### 4.1 🟢 get_task 无权限检查 — 信息泄露

**位置**: `handlers.js:137-140`

```javascript
async function _getTask(args, ctx) {
  const task = queue.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  return { task };
}
```

**问题**: `get_task` 不需要 `ctx.uid`（agent 无需注册即可查询任意 task）。任何建立了 SSE session 但未 `register_agent` 的客户端都可以查询任意 task_id。

**影响程度**: 🟢 **低** — 原因：
1. Task 不包含敏感数据（只有 sender name, content, status）
2. 攻击者仍需要知道 task_id（38 字符随机字符串）
3. 仅限本地回环访问

**修复建议**:
```javascript
async function _getTask(args, ctx) {
  if (!ctx.uid) return { error: 'not registered — register_agent first' };
  const task = queue.getTask(args.task_id);
  if (!task) return { error: 'task not found' };
  // 只允许 sender 或 receiver 查看
  if (task.sender.uid !== ctx.uid && task.receiver_uid !== ctx.uid) {
    return { error: 'not authorized to view this task' };
  }
  return { task };
}
```

---

### 4.2 🟢 register_agent 重放攻击风险评估

**位置**: `registry.js:10-38`

**问题分析**: `register_agent` 是幂等的 — 相同的 `(name, workspace)` 永远返回相同的 UID。register 时也检测为 "reconnected"。

**重放风险**: 🟢 **不存在** — 原因：
1. `register_agent` 不产生副作用（不修改其他 agent 状态）
2. 幂等设计是特性，不是 bug — agent 断线重连时应该拿回相同的 UID
3. 没有"一次性令牌"或"注册码"概念需要防重放

**唯一风险**: 如果攻击者知道目标 agent 的 `(name, workspace)`，可以"reconnect"并读取其收件箱中的 pending tasks。但这要求：
- 攻击者已经在 localhost 上
- 知道 name 和 workspace 字符串

**修复建议**: 添加可选的 `BOOS_AGENT_BUS_TOKEN` 预共享密钥，register 时验证。

---

### 4.3 🟢 跨 workspace 隔离 — 设计正确

**位置**: `handlers.js:78-81`

```javascript
if (receiver.workspace !== ctx.workspace) {
  return { error: 'cannot send tasks across workspaces' };
}
```

**评估**: ✅ **正确** — workspace 之间的隔离在 handler 层强制执行：
- `send_task` 拒绝跨 workspace 发送
- `list_agents` 只返回当前 workspace 的 agent
- `broadcast` 只广播到当前 workspace

---

## 5. 数据安全 (`store.js`)

### 5.1 🟢 JSON 文件存储 — 本地攻击面

**位置**: `store.js:32`

```javascript
const FILE = path.join(DATA_DIR, 'agent-bus.json');
```

**评估**: 🟢 **可接受** — 数据存储在 `~/.boos/agent-bus.json`，继承文件系统权限：
- 使用 `atomicWriteJson`（tmp + fsync + rename）保证写入原子性
- 使用 `withFileLock` 序列化所有写入操作
- 无 SQL 注入风险（JSON 解析）
- 文件内容不加密 — 但所有内容已经是 agent 可见的（task content, names）

**次要建议**: 添加 `agent-bus.json.bak` 自动备份机制（已在 `atomicJson.js` 实现）。

---

## 6. 通知机制安全 (`notifications.js`)

### 6.1 🟢 PTY 注入 — 受控风险

**位置**: `notifications.js:24`

```javascript
const WAKE_MESSAGE = '\n[agent-bus] 你有新的协作任务到达收件箱。请调用 check_inbox 获取。\n';
```

**评估**: ✅ **安全** — 通知消息是硬编码的，不包含用户/agent 可控内容。即使 session 匹配逻辑出错，写入 PTY 的消息始终是固定的。

---

## 7. 修复优先级

| 优先级 | 问题 | 修复难度 | 影响 |
|--------|------|---------|------|
| 🔴 P0 | sessionId 可预测 | 低 (1 行) | 会话劫持 |
| 🔴 P0 | SSE 无认证 | 中 (~20 行) | 身份伪造 |
| 🟡 P1 | broadcast 无速率限制 | 低 (~15 行) | DoS |
| 🟡 P1 | content 未清洗 | 低 (~10 行) | 注入 |
| 🟡 P2 | task_id 外部可控 | 低 (1 行) | 冲突/伪造 |
| 🟢 P3 | get_task 无权限检查 | 低 (~5 行) | 信息泄露 |
| 🟢 P3 | task 无过期机制 | 中 (~30 行) | 磁盘膨胀 |

---

## 8. 正面发现 ✅

以下安全实践值得肯定：

1. **跨 workspace 隔离** — handler 层强制，无法绕过
2. **sender-only 控制** — cancel/interrupt 仅允许发送方操作
3. **receiver-only 响应** — respond 仅允许接收方操作
4. **长度截断** — 所有字符串字段在写入前截断（name: 64, intro: 256, content: 4096）
5. **原子写入** — `atomicWriteJson` 使用 tmp + fsync + rename，防止文件损坏
6. **会话 TTL** — SSE session 10 分钟自动过期
7. **无端口暴露** — agent-bus 嵌入 BOOS Express，不监听额外端口
8. **通知去重** — `notifications.js` 30 秒去重，防止 PTY 洪水
9. **自发送保护** — `send_task` 拒绝向自己发送任务

---

## 附录: 审查方法

- **静态分析**: 逐行审查所有 `lib/agentBus/*.js` 文件
- **威胁建模**: STRIDE 模型 (Spoofing, Tampering, Repudiation, Information Disclosure, DoS, Elevation)
- **数据流追踪**: 追踪 `content`、`name`、`intro` 等用户输入字段从输入到存储的完整路径
- **边界条件**: 测试空输入、超长输入、特殊字符、并发场景
