# 生命周期管理重写设计

> 日期: 2026-07-13 | 状态: 设计阶段

---

## 当前问题

```
用户关闭浏览器 → 12s 延迟 → 服务被杀死
```

| 问题 | 影响 |
|------|------|
| 关闭浏览器窗口 → 服务被杀 | 用户以为关窗口只是隐藏，结果 PTY 会话全丢 |
| `BOOS_KEEP_ALIVE=1` 是唯一的逃生舱 | 新用户不知道这个环境变量 |
| 心跳监控仅在 `BOOS_LAUNCHER=1` 时启用 | 直接启动 `server.js` 没有保护 |
| 浏览器退出监听仅在 `kind==='app'` 时注册 | PWA 模式下关闭窗口不触发 |

---

## 目标设计

```
┌──────────────────────────────────────────────────────┐
│                     BOOS 生命周期                      │
│                                                      │
│  浏览器关闭 ───→ 服务继续运行 (不再杀死服务)            │
│                                                      │
│  服务退出条件 (满足任一即可):                           │
│  1. POST /api/shutdown (显式关闭)                      │
│  2. 空闲超时: 30min 无 session + 无心跳 + 无 MCP 连接    │
│  3. BOOS_KEEP_ALIVE=1 → 永不休眠 (dev/automation)      │
│                                                      │
│  服务存活条件 (任一为真则存活):                          │
│  - 有 running 状态的 session (PTY 活跃)                 │
│  - 最近 5min 内有前端心跳                               │
│  - 有活跃的 agent-bus MCP SSE 连接                      │
└──────────────────────────────────────────────────────┘
```

---

## 具体改动

### 1. 删除浏览器关闭 → 服务杀死

**server.js L2167-2185 — 删除:**
```js
// 旧代码: opened.child.on('exit') → gracefulShutdown
// 删除整个 if (opened.kind === 'app' ...) 块
```

**替代:** 无。浏览器关闭不触发任何服务端行为。

### 2. 统一空闲检测器 (IdleWatcher)

**新建 `lib/idleWatcher.js`:**

```js
// 单例, 每 60s 检查一次
// 检查项:
//   1. persistedSessions 中有 running 状态的 session?
//   2. 最近 5min 有 heartbeat?
//   3. agent-bus transport._sessions.size > 0?
//
// 如果以上全为 false → 累计空闲时间
// 空闲 > IDLE_TIMEOUT_MS (默认 30min) → gracefulShutdown
// BOOS_KEEP_ALIVE=1 → 跳过所有检查, 永不休眠

const IDLE_CHECK_MS = 60_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;   // 30 min
const HEARTBEAT_WINDOW_MS = 5 * 60_000; // 5 min
```

### 3. 心跳监控始终启用

**当前:** 仅在 `BOOS_LAUNCHER=1` 时启用
**目标:** 始终启用。移除 `BOOS_LAUNCHER` 条件

```js
// 旧: if (process.env.BOOS_LAUNCHER === '1' ...)
// 新: 始终启动
if (process.env.BOOS_KEEP_ALIVE !== '1') {
  startHeartbeatWatchdog();
  startIdleWatcher();
}
```

### 4. 新增 API: 存活状态

**GET /api/keep-alive/status**

```json
{
  "keepAlive": true,
  "activeSessions": 2,
  "lastHeartbeatMs": 4500,
  "mcpConnections": 1,
  "idleTimeMs": 0,
  "willShutdownAfterMs": 1800000
}
```

### 5. 环境变量语义更新

| 变量 | 旧行为 | 新行为 |
|------|--------|--------|
| `BOOS_KEEP_ALIVE=1` | 禁用浏览器退出钩 + 心跳监控 | **永不休眠** — 跳过所有自动关闭 |
| `BOOS_LAUNCHER=1` | 启用心跳监控 | **废弃** — 心跳监控始终启用 |
| `BOOS_NO_BROWSER=1` | 抑制自动打开浏览器 | **不变** |
| `BOOS_IDLE_TIMEOUT` | 不存在 | **新增** — 自定义空闲超时(ms), 默认 1800000 |

---

## 实施步骤

### Phase 1: 删除浏览器退出钩子 (最小改动)
- server.js: 删除 L2167-2185 的 `opened.child.on('exit')` 块
- 移除 `lastHeartbeat > closedAt + 100` 判断
- 结果: 关闭浏览器窗口 → 服务继续运行

### Phase 2: 统一空闲检测
- 新建 `lib/idleWatcher.js`
- server.js: 在 boot IIFE 中启动 idleWatcher
- 移除 `BOOS_LAUNCHER` 条件 — 心跳监控始终运行

### Phase 3: API 增强
- 新增 `GET /api/keep-alive/status`
- frontend OfflineBanner 可读取此 API 显示 "Server will auto-stop in X min" 警告

### Phase 4: 清理
- 移除 `BOOS_LAUNCHER` 环境变量引用
- 更新 CLAUDE.md 文档

---

## 风险

| 风险 | 缓解 |
|------|------|
| 用户忘记关服务, 后台一直运行 | 30min 空闲自动退出 |
| 30min 太短 (用户离开吃午饭) | `BOOS_IDLE_TIMEOUT` 可配置 |
| `BOOS_KEEP_ALIVE=1` 导致服务永远不退出 | 这是用户显式选择, 合理 |

---

## 文件变更清单

| 操作 | 文件 | 行数 |
|------|------|------|
| 新建 | `lib/idleWatcher.js` | ~60 |
| 修改 | `server.js` 删除浏览器钩子 | -24 |
| 修改 | `server.js` 启动 idleWatcher | +8 |
| 修改 | `server.js` 新增 /api/keep-alive/status | +15 |
| 修改 | `server.js` 移除 BOOS_LAUNCHER 条件 | -3 |
