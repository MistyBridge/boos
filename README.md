# boos — Claude Code Session Manager

A single pane over every Claude / Codex / Copilot CLI session on your
machine. Each session runs inside the page (xterm.js + a PTY pool in
the local backend), gets recorded by filesystem folder, and resumes in
that folder when you click it again.

[![open](https://img.shields.io/badge/open-MistyBridge.github.io%2Fboos-1a1815?style=flat-square)](https://MistyBridge.github.io/boos/)

```
┌── browser ─────────────────────────┐
│  https://MistyBridge.github.io/boos/  ← version router
│                  ↓
│  /boos/X.Y.Z/   ← per-version frontend (pinned to your backend)
└────────────┬───────────────────────┘
             │  fetch /api/*   (CORS)
             │  ws://localhost:7777/ws/*
             ▼
┌── local backend ───────────────────┐
│  boos (npm bin)                    │
│   ├── /api/sessions  /api/sessions/new   │
│   ├── /api/sessions/:id/resume     │
│   ├── /api/version  /api/upgrade   │
│   ├── /ws/terminal/:id (PTY)       │
│   └── /api/health  /api/heartbeat  │
└────────────────────────────────────┘
```

## What it does

- **Runs every CLI session in the page.** `claude`, `codex`, `copilot`
  or any custom command, in an xterm.js panel. Switch sessions in the
  sidebar; the PTY keeps running in the backend.
- **Exact session resume when available.** boos records each session's
  CLI, `cwd`, and discovered upstream session id. Click a stopped
  session later and boos resumes that exact conversation when the CLI
  supports resume-by-id, falling back to the configured "resume latest"
  command or the CLI's resume picker.
- **Workspaces + clones.** "New session" picks an unused workspace
  under your work-dir, clones selected repos with live `git clone
  --progress` streamed to per-repo progress bars, and opens a fresh CLI
  in the single selected repo or at the workspace root for zero/multiple
  repos. Or pick any existing folder via the file browser.
- **Folders.** Drag sessions into named folders for organisation.
- **In-app upgrade.** About page checks npm for newer versions of
  boos and offers a one-click upgrade button. Backend self-restarts.

## Install

```bash
npm i -g @MistyBridge/boos
```

This:
- puts `boos` on your PATH
- registers a `boos://` URL protocol so the hosted frontend can wake
  the backend with one click

`npx @MistyBridge/boos` works too for a one-shot trial — the protocol
still gets registered.

## Use

```bash
boos                       # starts the backend, opens the frontend
```

Or just visit **https://MistyBridge.github.io/boos/** in any browser.
If the backend isn't running, the router shows a "Backend not running"
banner with a **Start boos** button — click it, Windows asks once
whether to open the `boos://` handler (check "Always allow"), and the
backend spawns silently behind the page. The router auto-reconnects in
1-2s and redirects to the frontend matching your installed backend
version.

### Install as PWA

In Chrome / Edge, click the install icon in the address bar (or use the
"Install boos" button on the **About** tab inside the app). The PWA gets
its own window, its own icon, and Window Controls Overlay so the title
bar blends into the page.

After installing, clicking the PWA icon is the new entry point — no
terminal needed.

## Defaults

| | |
|---|---|
| Port | `7777` (auto-bumps if taken) |
| Work dir | `~/boos-workspaces` (each subdirectory holds one or more repo clones) |
| Built-in CLIs | `claude`, `codex`, `copilot` — add your own via the **Configure** tab |
| Resume behavior | `latest` by default; switch to `picker` in **Configure** |
| Data dir | `~/.boos/` (override with `BOOS_HOME=<path>`) — survives upgrades and npx cache wipes |

All of the above are editable through the **Configure** tab.

## Layout

```
boos/
├── server.js                 # Express + WebSocket; API only in prod
├── bin/boos.js               # launcher · detaches server, opens browser
├── scripts/
│   ├── install.js            # postinstall · registers boos:// (Windows)
│   └── uninstall.js          # preuninstall · cleanup
├── lib/
│   ├── persistedSessions.js  # ~/.boos/sessions.json — the source of truth
│   ├── folders.js            # sidebar tree
│   ├── workspace.js          # ws-N allocation + repo clones
│   ├── webTerminal.js        # node-pty pool · WebSocket bridge
│   ├── jsonStore.js · config.js
├── pages-root/               # → GH Pages /  (version router)
└── public/                   # → GH Pages /<pkg.version>/  (per-version frontend)

~/.boos/                       # or $BOOS_HOME
├── config.json
├── sessions.json              # persisted sessions
├── folders.json
├── server.log
└── browser-profile/           # Edge/Chrome --user-data-dir
```

## How "wake on click" works

The hosted frontend lives entirely in the browser sandbox — it cannot
spawn processes. So when the backend is down, the OfflineBanner's
**Start boos** is a plain `<a href="boos://start">`. The OS hands that
off to a per-user URL protocol handler registered at install time:

```
HKCU\Software\Classes\boos\shell\open\command
  → wscript.exe "<LOCALAPPDATA>\boos\launcher.vbs" "%1"
```

The `.vbs` calls `boos.cmd "boos://start"` with `WindowStyle = 0`. That
gets to `bin/boos.js`, which parses the protocol URL, spawns
`server.js` detached, and exits. Zero windows ever flash.

First click triggers a one-time Windows dialog ("Open boos.cmd?"). Tick
**Always allow** and future clicks are silent.

## Lifecycle (when does the backend die)

| trigger | reaction |
|---|---|
| The auto-opened browser window closes | wait 12s · if any other client heartbeats during that window, stay alive; otherwise gracefulShutdown |
| No heartbeat for 90s | gracefulShutdown |
| `POST /api/shutdown` | gracefulShutdown |
| `POST /api/upgrade` after install | self-respawn + gracefulShutdown |
| SIGINT / SIGTERM | gracefulShutdown |

## Dev

```bash
git clone https://github.com/MistyBridge/boos
cd boos
npm install
BOOS_NO_BROWSER=1 BOOS_KEEP_ALIVE=1 node server.js
# opens http://localhost:7777 with hot-reload (public/ is served locally
# and SSE pushes a reload event on every file save)
```

Dev mode is detected via `__dirname.includes('node_modules')` — when
running from a checkout, the backend also serves `public/`. In an
npm-installed copy it's API-only, and you use the hosted frontend.

## Versioning (frontend ↔ backend)

The hosted root (`/boos/`) is a tiny static **version router**: it
probes `localhost:7777/api/health`, then redirects you to
`/boos/<backend.version>/`. Each release publishes a fresh
per-version subdir; old ones stay forever. No semver-compat logic — a
frontend is always 1:1 with the backend it was built against.

If your backend gets upgraded under a still-loaded page, the
per-version frontend detects the mismatch on its next probe and
bounces you back through the router automatically.

## Status

- Backend: Windows-first. macOS / Linux backend ports planned (URL
  protocol registration is the only platform-specific install piece).
- Frontend: cross-platform (pure web).

See [CLAUDE.md](CLAUDE.md) for design decisions and the non-obvious
gotchas baked into the launcher, session lifecycle, and workspace code.
