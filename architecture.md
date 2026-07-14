# BOOS Architecture

> v1.0.0 · 2026-07-14 · 97 source files · ~24,000 lines

## Overview

BOOS (Bridge for Orchestrating & Operating multi-agent Sessions) is a
multi-agent session manager built on Node.js/Express + Preact. It runs
Claude Code/Codex/Copilot CLI sessions inside a single web app with
in-process PTYs (node-pty), persistent session state, and an embedded
MCP agent-to-agent message bus.

```
┌── browser ───────────────────────────────────┐
│  https://MistyBridge.github.io/boos/           │  version router
│  https://MistyBridge.github.io/boos/X.Y.Z/     │  per-version frontend
└────────────┬─────────────────────────────────┘
             │  fetch /api/* (CORS) + ws://
             ▼
┌── BOOS Backend (Express + WebSocket) ────────┐
│  server.js (527 lines)                        │  coordination layer
│  ├── routes/ (12 files, 1,306 lines)          │  REST API
│  ├── lib/ (16 modules)                        │  business logic
│  ├── lib/agentBus/ (6 files)                  │  embedded MCP bus
│  └── public/                                   │  Preact frontend
└──────────────────────────────────────────────┘
```

## Component Architecture

```
server.js (527 lines — lifecycle, WS upgrade, route wiring)
├── middlewares: CORS, deviceGate, hostOnlyGate
├── agent-bus:   /mcp/sse + /mcp/message (JSON-RPC 2.0)
├── PostgreSQL:  lib/postgres.js → boos-db container
├── idleWatcher: 30min auto-shutdown
└── heartbeat:   90s watchdog (launcher mode)

routes/ (12 files)
├── config.js          (96L)   GET/PUT /api/config
├── sessions.js        (148L)  CRUD /api/sessions/:id
├── sessions-launch.js (360L)  POST /api/sessions/new + resume
├── workspaces.js      (135L)  GET /api/workspaces + /api/browse
├── health.js          (113L)  /api/health, /api/capabilities, /api/heartbeat
├── version.js         (138L)  GET /api/version, POST /api/upgrade
├── tunnel.js          (105L)  Remote access via devtunnel
├── devices.js         (67L)   Device approval flow
├── folders.js         (49L)   Folder CRUD + reorder
├── decisions.js       (59L)   Decision system API
├── dev.js             (36L)   Hot-reload SSE (dev mode only)
└── tunnel.js          (105L)  Remote tunnel management

lib/ (16 core modules)
├── agentBus/              Embedded MCP agent-to-agent bus
│   ├── transport.js       SSE + JSON-RPC (Express Router at /mcp)
│   ├── handlers.js        Tool dispatch (21 tools)
│   ├── schemas.js         JSON Schema definitions (21 tools)
│   ├── store.js           File-backed persistent task queue
│   ├── queue.js           FIFO inbox + EventEmitter
│   ├── registry.js        Agent registration + heartbeat
│   ├── notifications.js   Queue → PTY push bridge
│   └── workspace.js       Per-workspace agent isolation
├── persistedSessions.js   ~/.boos/sessions.json — single source of truth
├── sessionBinding.js      PID → CLI sessionId scanner (10s periodic)
├── webTerminal.js         node-pty pool + WebSocket bridge
├── workspace.js           ws-N allocation + repo cloning
├── config.js              loadConfig/saveConfig + DATA_DIR
├── folders.js             Sidebar folder tree
├── jsonStore.js           Keyed-JSON store factory
├── atomicJson.js          Atomic writes (tmp + rename) + withFileLock
├── sessionHelpers.js      spawnSessionRecord, resolveCommand
├── cliHelpers.js          CLI detection, resume arg builders
├── browserLauncher.js     Edge/Chrome --app= window launcher
├── idleWatcher.js         30min idle → auto-shutdown (MCP-aware)
└── localCliSessions.js    ~/.claude/sessions/*.json reader

public/ (Preact + Signals frontend)
├── js/
│   ├── main.js            Boot, version guard, heartbeat
│   ├── state.js           Signals (reactive state)
│   ├── api.js             fetch wrappers, dedup-aware resumeSession
│   ├── streaming.js       NDJSON clone-progress stream reader
│   ├── backend.js         httpBase() / wsBase() (cross-origin aware)
│   ├── pages/             6 pages: Sessions, Launch, Configure, About, Remote, Workspace
│   └── components/        30+ components: TerminalView, AgentCanvas, Sidebar, ...
└── css/                   12 stylesheets, Design Tokens (warm cream palette)
```

## Data Flow

### Session Lifecycle

```
POST /api/sessions/new { cliId, cwd, repos? }
  → findOrCreateWorkspace(cwd)      // allocate ws-N
  → ensureReposInWorkspace(repos)   // git clone (NDJSON stream)
  → spawnSessionRecord(cfg, cwd)    // node-pty spawn CLI
  → persistedSessions.insert(id)    // persist record
  → sessionBinding.scheduleScan()   // discover cliSessionId
  → webTerminal.attach(id, ws)      // xterm.js bridge
```

### Agent-Bus Task Flow

```
Agent A (Claude Code)                   BOOS Express                     Agent B (Claude Code)
─────────────────────                   ────────────                     ─────────────────────
register_agent ──────────────────→ /mcp/sse (SSE connect)
                                    ←─ endpoint + MCP initialize
tools/list ──────────────────────→
                                    ←─ 21 tools (incl. wake_agent)
send_task(to=B, content) ────────→ queue.sendTask()
                                    ←─ { ok, task_id }
                                    queue → inboxEvents('task_available')
                                    notifications.js → PTY write to B
                                    ←─ SSE: notifications/agent_bus/inbox_updated

Agent B's next turn:
check_inbox() ────────────────────→ queue.checkInbox(B)
                                    ←─ { task, instant: true }
  ... execute task ...
respond_task(id, result) ─────────→ queue.respondTask()
                                    ←─ { ok: true }

wake_agent(B) ────────────────────→ notifications.wakeAgent(B)
                                    PTY write: "[agent-bus] 🔔 ..."
                                    ←─ { ok, session_id }
```

## MCP Tool Inventory (21 tools)

| Category | Tools |
|----------|-------|
| Registration | register_agent, deregister_agent, list_agents, list_all_agents |
| Task Queue | send_task, check_inbox, cancel_task, interrupt_task, respond_task, list_my_tasks, get_task |
| Broadcast | broadcast |
| Wake-Up | wake_agent |
| Workflow | define_workflow, add_stage, add_dependency, activate_workflow |
| Decision | request_decision, check_decisions |
| Supervisor | assign_task, kill_worker |
| Terminal | boos_terminal_list |

## Key Design Decisions

1. **Frontend/backend version pinning**: GH Pages router probes
   `localhost/api/health` → redirects to `/<version>/`. Each release
   publishes a new subdir; old ones stay forever.

2. **Exact-then-fallback resume**: Resume by `cliSessionId` when known;
   fallback to `--continue` (latest) or `--resume` (picker) at record cwd.

3. **Browser-skip lifecycle**: Browser close no longer kills server.
   Heartbeat watchdog (90s) + idleWatcher (30min) handle auto-shutdown.

4. **Agent-Bus embedded**: No separate process/port. MCP transport lives
   in-process at `/mcp/sse`. Queue persisted to `~/.boos/agent-bus-store.json`.

5. **File-backed persistence**: `sessions.json` is single source of truth.
   `atomicJson.js` uses tmp+rename for atomic writes with per-file locks.

6. **Agent TTL disabled (Sprint 6)**: SSE sessions and agent heartbeats
   never expire by default. Agents persist across restarts.

## API Surface

| Method | Path | Purpose |
|--------|------|---------|
| GET/PUT | /api/config | Config CRUD |
| GET | /api/sessions | List all sessions |
| PUT/DELETE | /api/sessions/:id | Rename/move/delete |
| POST | /api/sessions/:id/stop | Stop PTY, keep record |
| POST | /api/sessions/:id/resume | Re-spawn at record cwd |
| POST | /api/sessions/:id/switch-cli | Change CLI type |
| POST | /api/sessions/new | Launch new (NDJSON stream) |
| GET/POST | /api/folders | Folder CRUD |
| GET | /api/workspaces | List workspaces |
| GET | /api/browse | Directory browser |
| GET | /api/version | Version + update check |
| POST | /api/upgrade | npm i -g + self-restart |
| GET | /api/health | Health check |
| POST | /api/heartbeat | Frontend heartbeat |
| POST | /api/spawn-browser | Open browser window |
| POST | /api/shutdown | Graceful exit |
| GET | /api/capabilities | Feature advertisement |
| GET | /mcp/sse | Agent-Bus SSE stream |
| POST | /mcp/message | Agent-Bus JSON-RPC |
| POST | /mcp/api/call | Simple REST bridge |
| GET | /mcp/health | Agent-Bus health |
| WS | /ws/terminal/:id | xterm.js PTY bridge |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| BOOS_HOME | Config/data dir (default: ~/.boos/) |
| BOOS_PORT | Override listen port |
| BOOS_KEEP_ALIVE | Disable auto-shutdown |
| BOOS_NO_BROWSER | Suppress auto-open browser |
| BOOS_NO_DEV | Disable dev mode features |
| BOOS_NO_AGENT_BUS | Disable embedded MCP transport |
| BOOS_NO_AGENT_BUS_WATCH | Disable PTY push notifications |
| BOOS_NO_POSTGRES | Skip PG container + sync |
