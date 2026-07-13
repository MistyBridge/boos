# BOOS Architecture v1.0.0

> 绘制日期: 2026-07-13 | 代码行数: ~24,000 (97 files)

---

## 系统全景

```
                          ┌──── browser ──────────────────────────────────┐
                          │  https://MistyBridge.github.io/boos/           │
                          │           │ version router probes              │
                          │           │ localhost:7777/api/health          │
                          │           ▼                                    │
                          │  https://MistyBridge.github.io/boos/X.Y.Z/     │
                          │  ┌──────────────────────────────────────────┐ │
                          │  │          Preact + Signals SPA            │ │
                          │  │  ┌───────┐ ┌───────┐ ┌───────────────┐  │ │
                          │  │  │Sidebar│ │ Pages │ │  Components   │  │ │
                          │  │  │folders│ │Session│ │ TerminalView  │  │ │
                          │  │  │ tree  │ │Launch │ │ AgentCanvas   │  │ │
                          │  │  │       │ │Config │ │ ProgressList  │  │ │
                          │  │  │       │ │About  │ │ ServerStatus  │  │ │
                          │  │  └───────┘ └───────┘ └───────────────┘  │ │
                          │  └──────────────────────────────────────────┘ │
                          └──────┬──────────────────┬─────────────────────┘
                                 │ fetch /api/*     │ ws://localhost:7777
                                 │ (CORS allow-list) │ /ws/terminal/:id
                                 ▼                   ▼
┌─ local backend ─────────────────────────────────────────────────────────┐
│                                                                          │
│  server.js (2311 lines)  ←── REFACTOR TARGET ──→  routes/ (planned)     │
│  ╔══════════════════════════════════════════════════════════════════╗    │
│  ║  Express + ws                                                    ║   │
│  ║  ┌─────────────────────────────────────────────────────────┐    ║   │
│  ║  │  Routes (18 handlers)                                    │    ║   │
│  ║  │  sessions · folders · workspaces · config · health       │    ║   │
│  ║  │  version · upgrade · shutdown · browse · heartbeat       │    ║   │
│  ║  │  capabilities · spawn-browser · tunnel · devices          │    ║   │
│  ║  │  WebSocket upgrade → /ws/terminal/:id                     │    ║   │
│  ║  └─────────────────────────────────────────────────────────┘    ║   │
│  ╚══════════════════════════════════════════════════════════════════╝   │
│                                    │                                     │
│            ┌───────────────────────┼───────────────────────┐            │
│            ▼                       ▼                       ▼            │
│  ┌──────────────┐   ┌──────────────────────┐   ┌──────────────────┐    │
│  │ persisted     │   │ webTerminal.js       │   │ tunnel.js        │    │
│  │ Sessions.js   │   │ node-pty pool        │   │ devtunnel        │    │
│  │ sessions.json │   │ WS ↔ PTY bridge      │   │ remote access    │    │
│  └──────┬───────┘   └──────────────────────┘   └──────────────────┘    │
│         │                                                               │
│  ┌──────┴──────────────────────────────────────────────┐               │
│  │               lib/ (data layer)                      │               │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │               │
│  │  │atomicJson│ │jsonStore │ │ config   │ │folders │ │               │
│  │  │fsync     │ │generic   │ │~/.boos/  │ │tree    │ │               │
│  │  │+backup   │ │CRUD      │ │config    │ │CRUD    │ │               │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │               │
│  │       └────────────┴────────────┴───────────┘       │               │
│  │  ┌──────────────┐ ┌────────────────┐ ┌───────────┐  │               │
│  │  │ workspace.js │ │sessionBinding  │ │ devices   │  │               │
│  │  │ws-N alloc    │ │CLI session     │ │remote     │  │               │
│  │  │repo clone    │ │id discovery    │ │pairing    │  │               │
│  │  └──────────────┘ └────────────────┘ └───────────┘  │               │
│  │  ┌──────────────────┐ ┌──────────────────────┐       │               │
│  │  │localCliSessions  │ │agentBusWatcher.js    │       │               │
│  │  │CLI process mgmt  │ │SSE client (NEEDS     │       │               │
│  │  │resume logic      │ │RECONNECT FIX)        │       │               │
│  │  └──────────────────┘ └──────────────────────┘       │               │
│  └─────────────────────────────────────────────────────┘               │
│                                                                          │
│  ┌── ~/.boos/ (persistent state) ────────────────────────────────────┐  │
│  │  config.json  ·  sessions.json  ·  folders.json  ·  server.log    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 数据流

### Session 启动流程

```
Frontend                    server.js                   lib/
   │                           │                         │
   │ POST /api/sessions/new    │                         │
   │ {cliId, cwd?, repos?} ──▶ │                         │
   │                           ├─ findOrCreateWorkspace()─▶ workspace.js
   │                           │                         │  → ws-N/
   │                           ├─ ensureReposInWorkspace()─▶ workspace.js
   │                           │                         │  → git clone
   │  ◄── NDJSON stream ──────┤                         │
   │  {workspace}              │                         │
   │  {clone-start/progress}   │                         │
   │                           ├─ webTerminal.create() ──▶ webTerminal.js
   │                           │                         │  → node-pty spawn
   │                           ├─ persistedSessions ─────▶ persistedSessions.js
   │                           │  .add(record)           │  → sessions.json
   │                           ├─ sessionBinding ────────▶ sessionBinding.js
   │                           │  .watch(id, cliPid)     │  → discover cliSessionId
   │  ◄── {launched} ─────────┤                         │
   │  ◄── {done} ─────────────┤                         │
   │                           │                         │
   │ WebSocket /ws/terminal/:id│                         │
   │ ◄══════════════ PTY I/O ═══════════════════════════▶│ (node-pty)
```

### Session Resume 流程

```
Frontend                    server.js                   lib/
   │                           │                         │
   │ POST /sessions/:id/resume │                         │
   │                         ─▶│                         │
   │                           ├─ persistedSessions ─────▶ persistedSessions.js
   │                           │  .get(id)               │  load record
   │                           │                         │
   │                           ├─ cliSessionId?          │
   │                           │  YES → resumeIdArgs ◀───▶ sessionBinding.js
   │                           │  NO  → resumeLatestArgs  │ (fallback)
   │                           │       or resumePickerArgs│
   │                           │                         │
   │                           ├─ webTerminal.create() ──▶ webTerminal.js
   │  ◄── {ok, id} ───────────┤                         │
```

### 生命周期

```
    bin/boos.js                    server.js
       │                              │
       │ spawn detached               │
       │ BOOS_LAUNCHER=1              │
       ├─────────────────────────────▶│
       │                              ├─ Express listen(7777)
       │                              ├─ if !BOOS_NO_BROWSER → Edge --app=
       │                              ├─ Heartbeat watchdog (90s)
       │                              │
       │           ┌─ browser close ──┤
       │           │  (ignored <5s)   │
       │           │  (deferred 12s)  │
       │           ├─ POST /shutdown ─┤
       │           ├─ SIGINT/SIGTERM  │
       │           └─ watchdog fire ──┤
       │                              ├─ gracefulShutdown()
       │                              │  ├─ markExited all running
       │                              │  ├─ webTerminal.gracefulKillAll()
       │                              │  ├─ tunnel.stop()
       │                              │  └─ process.exit(0)
       │  ◄── exit 0 ────────────────┤
```

---

## 依赖矩阵

```
                    server.js
                        │
        ┌───────┬───────┼───────┬───────┬───────┬───────┐
        ▼       ▼       ▼       ▼       ▼       ▼       ▼
     persist webTerm  tunnel  folders config  work   devices
     Sessions .js     .js     .js     .js     space  .js
        │       │               │       │       .js
        ▼       ▼               ▼       ▼       │
     atomic  localCli          json   atomic    │
     Json    Sessions          Store  Json      │
     .js     .js               .js    .js       │
        │       │               │       │       │
        └───────┴───────────────┴───────┴───────┘
                        │
                  ~/.boos/*.json
```

| 模块 | 被依赖 | 依赖 |
|------|--------|------|
| `atomicJson.js` | persistedSessions, jsonStore, folders, config, devices | fs |
| `persistedSessions.js` | server.js | atomicJson |
| `webTerminal.js` | server.js | node-pty, ws |
| `workspace.js` | server.js | fs, child_process |
| `jsonStore.js` | persistedSessions, folders, devices | atomicJson, fs |
| `config.js` | server.js | atomicJson |
| `sessionBinding.js` | server.js | (CLI traces) |
| `localCliSessions.js` | server.js | child_process |
| `agentBusWatcher.js` | server.js | SSE (EventSource) |
| `tunnel.js` | server.js | devtunnel |
| `devices.js` | server.js | jsonStore, crypto |

---

## 痛点标注

| # | 痛点 | 位置 | 严重度 |
|---|------|------|--------|
| 1 | 2311 行巨石 — 所有路由混在一个文件 | `server.js` | 🔴 P0 |
| 2 | `writeFile` 无 `fsync` — 崩溃可能丢数据 | `atomicJson.js` | ✅ 已修复 |
| 3 | 浏览器关闭 = 服务杀死 — 不合理 | `server.js` gracefulShutdown | 🔴 P0 |
| 4 | SSE 断连无重试 — Agent-Bus 断开不恢复 | `agentBusWatcher.js` | 🔴 P0 |
| 5 | 0 测试覆盖 — 无安全网 | 全局 | 🔴 P0 |
| 6 | `withFileLock` 无超时 — 可永久死锁 | `atomicJson.js` | ✅ 已修复 |
| 7 | Windows-only install.js — 缺 Mac/Linux | `scripts/install.js` | 🟡 P1 |

---

## 扩展点

```
server.js 拆分后:
  routes/
  ├── sessions.js      ← /api/sessions/*
  ├── folders.js       ← /api/folders/*
  ├── workspaces.js    ← /api/workspaces, /api/browse
  ├── config.js        ← /api/config
  ├── health.js        ← /api/health, /api/heartbeat, /api/capabilities
  ├── version.js       ← /api/version, /api/upgrade
  ├── shutdown.js      ← /api/shutdown
  ├── tunnel.js        ← /api/tunnel/*
  ├── devices.js       ← /api/devices/*
  ├── terminal.js      ← WebSocket upgrade /ws/terminal/:id
  └── browser.js       ← /api/spawn-browser

  共享中间件 (lib/middleware.js):
  ├── asyncH()         ← 异步错误捕获包装器
  ├── cors()           ← CORS 头
  └── remoteGuard()    ← 远程访问 token 验证
```
