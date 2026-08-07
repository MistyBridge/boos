// Session launch helpers extracted from server.js — resume-args builders,
// PTY spawn wrappers, and codex theme injection.
//
// Usage:
//   const { spawnSessionRecord, spawnSessionPickerRecord, buildResumeArgs,
//           launchCwdFor, workspaceOccupancySessions, workspaceOccupancyLabel,
//           resumeMode } = createSessionHelpers({
//     webTerminal, persistedSessions, resolveCommand, spawnEnv,
//     scheduleBindingScan, scheduleBindingScanSeries,
//   });

'use strict';
const errReport = require('./errorReport');   // Sprint 42: no silent failures


const path = require('node:path');
const os = require('node:os');

// ── global PTY spawn lock ───────────────────────────────────────────────
// Sprint 42 crash fix: node-pty's native spawn() is NOT safe to run
// concurrently on Windows (ConPTY) — parallel spawns (crash-reconnect
// loop racing stale-reclaim's _autoResumeSession, or manifest parallel
// restore) crash the whole process at the native layer: exit code 1,
// no JS stack, uncaughtException never fires. All spawn paths funnel
// through spawnSessionRecord/spawnSessionPickerRecord below — serialize
// them with one promise chain. Spawn itself is fast (ms); the chain
// only adds ordering, not meaningful latency.
let _spawnChain = Promise.resolve();
function _withSpawnLock(fn) {
  const run = _spawnChain.then(fn);
  _spawnChain = run.catch(() => {});
  return run;
}

// ── workspace helpers ──────────────────────────────────────────────────

function workspaceOccupancySessions(sessions, cfg) {
  return (sessions || []).filter((s) => s && s.cwd);
}

function workspaceOccupancyLabel(cfg) {
  return 'session';
}

function launchCwdFor(workspace, wantedRepos, explicitCwd) {
  return explicitCwd
    ? workspace.path
    : wantedRepos.length === 1
      ? path.join(workspace.path, wantedRepos[0].name)
      : workspace.path;
}

// ── resume mode / args builders ────────────────────────────────────────

function resumeMode(cfg) {
  return cfg?.resumeMode === 'picker' ? 'picker' : 'latest';
}

function buildFolderResumeArgs(cli, cfg) {
  const mode = resumeMode(cfg);
  const field = mode === 'picker' ? 'resumePickerArgs' : 'resumeLatestArgs';
  const args = Array.isArray(cli?.[field]) ? cli[field] : [];
  if (args.length === 0) {
    throw new Error(`CLI ${cli?.id || '(unknown)'} has no ${field} configured`);
  }
  return args;
}

function buildPickerResumeArgs(cli) {
  const args = Array.isArray(cli?.resumePickerArgs) ? cli.resumePickerArgs : [];
  if (args.length === 0) {
    throw new Error(`CLI ${cli?.id || '(unknown)'} has no resumePickerArgs configured`);
  }
  return args;
}

function buildResumeArgs(cli, cfg, record) {
  const sid = record && record.cliSessionId;
  const idArgs = Array.isArray(cli?.resumeIdArgs) ? cli.resumeIdArgs : [];
  if (sid && idArgs.length && idArgs.some((a) => String(a).includes('<id>'))) {
    return idArgs.map((a) => String(a).replace(/<id>/g, sid));
  }
  return buildFolderResumeArgs(cli, cfg);
}

// ── codex light-theme injection ────────────────────────────────────────

async function codexThemeArgs(cli, theme) {
  if (!cli || cli.type !== 'codex' || theme !== 'light') return [];
  const args = cli.args || [];
  const userSet = args.some(
    (a, i) => String(a).includes('tui.theme') || (a === '-c' && String(args[i + 1] || '').includes('tui.theme')),
  );
  if (userSet) return [];
  try {
    const { probeCodexHome, ensureCodexLightTheme } = require('./codexSeed');
    let home = null;
    try {
      home = await probeCodexHome({ command: cli.command, shell: cli.shell });
    } catch (e) { errReport.report("sessionHelpers", "probeCodexHome", e); }
    home = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (!(await ensureCodexLightTheme(home))) return [];
    return ['-c', 'tui.theme="boos-light"'];
  } catch {
    return [];
  }
}

// ── factory ────────────────────────────────────────────────────────────

// ── spawnSessionRecord bridge (set by createSessionHelpers, used by agent-bus) ─
let _spawnSessionRecord = null;
function setSpawnSessionRecord(fn) { _spawnSessionRecord = fn; }
function getSpawnSessionRecord() { return _spawnSessionRecord; }

function createSessionHelpers({
  webTerminal,
  persistedSessions,
  resolveCommand,
  spawnEnv,
  scheduleBindingScan,
  scheduleBindingScanSeries,
  managedAgents = [],
}) {
  // ── spawn a single CLI PTY ───────────────────────────────────────────

  function spawnCliSession({ cli, cwd, sessionId, meta, extraArgs = [], theme, cols, rows, onOutput }) {
    if (!webTerminal.available) {
      const e = new Error('node-pty unavailable · cannot spawn web terminal');
      e.code = 'PTY_UNAVAILABLE';
      throw e;
    }

    const userHasSettings = (cli.args || []).some((a) => a === '--settings' || String(a).startsWith('--settings='));
    const baseArgs = [...(cli.args || [])];
    if (cli.type === 'claude' && !userHasSettings) baseArgs.push('--settings', '{"theme":"auto"}');

    const resolved = resolveCommand(cli.command, [...baseArgs, ...extraArgs], cli.shell || 'direct');
    const { exe, prefixArgs, fallbackExe, consumesUserArgs } = resolved;
    const args = consumesUserArgs ? prefixArgs : [...prefixArgs, ...baseArgs, ...extraArgs];

    const env = spawnEnv(cli.env);

    if (theme === 'light' || theme === 'dark') {
      env.COLORFGBG = theme === 'light' ? '0;15' : '15;0';
    }

    const sized =
      Number(cols) > 0 && Number(rows) > 0
        ? {
            cols: Math.min(400, Math.max(20, Math.floor(Number(cols)))),
            rows: Math.min(200, Math.max(8, Math.floor(Number(rows)))),
          }
        : {};

    const trySpawn = (executable) =>
      webTerminal.spawn({
        id: sessionId,
        command: executable,
        args,
        cwd,
        env,
        ...sized,
        meta: { ...meta, cliId: cli.id, cliName: cli.name },
        onData: () => {
          persistedSessions.touch(sessionId).catch(() => {});
          try {
            require('./cliActivity').noteOutput(sessionId);
          } catch (e) { errReport.report("sessionHelpers", "touch", e); }
          if (onOutput) {
            try {
              onOutput();
            } catch (e) { errReport.report("sessionHelpers", "touch", e); }
          }
        },
        onExit: ({ exitCode }) => {
          persistedSessions.markExited(sessionId, exitCode).catch(() => {});
        },
      });

    try {
      const entry = trySpawn(exe);
      return entry;
    } catch (e) {
      if (fallbackExe && /ENOENT|cannot find|not recognized/i.test(String((e && e.message) || e))) {
        const entry = trySpawn(fallbackExe);
        return entry;
      }
      throw e;
    }
  }

  // ── spawn a session record ──────────────────────────────────────────

  // Sprint 42 crash fix: serialize ALL spawns through one global chain.
  // Native node-pty spawn() crashes on concurrent calls (Windows ConPTY) —
  // e.g. crash-reconnect loop + stale-reclaim auto-resume firing together.
  async function spawnSessionRecord(opts) {
    return _withSpawnLock(() => _spawnSessionRecordInner(opts));
  }

  async function _spawnSessionRecordInner({
    record,
    cli,
    cfg,
    body,
    resume = false,
    resumeArgsOverride = null,
    replaceLive = false,
    bindOnOutputForMs = 0,
    extraCliArgs = [],
    skipStartupInjection = false,
  }) {
    const live = webTerminal.get(record.id);
    if (live && !live.exitedAt) {
      if (!replaceLive) {
        if (record.status !== 'running' || record.pid !== live.meta.pid) {
          try {
            await persistedSessions.markRunning(record.id, live.meta.pid);
          } catch (e) { errReport.report("sessionHelpers", "markRunning", e); }
        }
        return { id: record.id, pid: live.meta.pid, cliId: record.cliId };
      }
    }

    const themeArgs = await codexThemeArgs(cli, body && body.theme);
    const folderResumeArgs = Array.isArray(resumeArgsOverride)
      ? resumeArgsOverride
      : resume
        ? buildResumeArgs(cli, cfg, record)
        : [];
    const bindOnOutputUntil = bindOnOutputForMs > 0 ? Date.now() + bindOnOutputForMs : 0;
    let lastOutputBindingScanAt = 0;
    const onOutput = bindOnOutputUntil
      ? () => {
          const now = Date.now();
          if (now > bindOnOutputUntil) return;
          if (now - lastOutputBindingScanAt < 1500) return;
          lastOutputBindingScanAt = now;
          scheduleBindingScan(300);
        }
      : null;

    // Sprint 33: Inject BOOS_CLI_SESSION_ID env var so agent knows its UUID.
    // cliSessionId = Claude --resume UUID = the agent's sole identity.
    // For resumed sessions it's already known; first-launch has null.
    const normCwd = (record.cwd || '').replace(/\\/g, '/').toLowerCase();
    const isManaged = managedAgents.some(
      a => a.replace(/\\/g, '/').toLowerCase() === normCwd
    );

    // Sprint 38: Managed agents → auto mode ON. Inject --permission-mode
    // bypassPermissions so agents never block on interactive permission
    // prompts. Only for Claude CLI type.
    const autoModeArgs = (isManaged && cli.type === 'claude')
      ? ['--permission-mode', 'bypassPermissions']
      : [];

    if (isManaged && record.cliSessionId) {
      try {
        const fs = require('node:fs');
        const mcpPath = path.join(record.cwd, '.mcp.json');
        let mcp = {};
        try {  mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));  } catch (e) { errReport.report("sessionHelpers", "parse", e); }
        mcp.mcpServers = mcp.mcpServers || {};
        const ab = mcp.mcpServers['agent-bus'];
        if (ab) {
          ab.env = ab.env || {};
          ab.env.BOOS_CLI_SESSION_ID = record.cliSessionId;
        }
        fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n', 'utf-8');
        console.log('[boos] .mcp.json injected cliSessionId for', record.id);
      } catch (e) { console.warn('[boos] .mcp.json injection failed for', record.id, e.message); }
    }

    const entry = spawnCliSession({
      cli,
      cwd: record.cwd,
      sessionId: record.id,
      meta: { title: record.title || record.workspace, workspace: record.workspace, cwd: record.cwd },
      extraArgs: [...extraCliArgs, ...autoModeArgs, ...themeArgs, ...folderResumeArgs],
      theme: body && body.theme,
      cols: body && body.cols,
      rows: body && body.rows,
      onOutput,
    });
    await persistedSessions.markRunning(record.id, entry.meta.pid);
    scheduleBindingScan();

    // Sprint 21: Startup injection — inject check_inbox for managed agents.
    // Sprint 38 v3: Delegates to notificationsWake._injectCommand() for single
    // source-of-truth injection (burst/paste/typed modes live there).
    // Delay 8s (was 5s) — Claude Code MCP init (agent-bus SSE + filesystem
    // + sequential-thinking) takes several seconds.
    // Sprint 38: Skip startup injection when caller handles it (auto-resume
    // via drainIfIdle injects immediately after the 8s wait — two injections
    // firing at T+8s would race and leave check_inbox[BOOS] in the input box).
    if (isManaged && !skipStartupInjection) {
      setTimeout(() => {
        try {
          const { _injectCommand } = require('./agentBus/notificationsWake');
          const errReport = require("./errorReport");
          _injectCommand(record.id, 'check_inbox[BOOS]');
          console.log('[boos] startup injection: check_inbox sent to session', record.id);
        } catch (e) {
          console.warn('[boos] startup injection failed:', record.id, e.message);
        }
      }, 8000);
    }

    return { id: record.id, pid: entry.meta.pid, cliId: cli.id };
  }

  // ── spawn a session in picker mode ──────────────────────────────────

  async function spawnSessionPickerRecord({ record, cli, cfg, body }) {
    const pickerArgs = buildPickerResumeArgs(cli);
    // Serialized through the same global spawn lock as spawnSessionRecord.
    const launched = await _withSpawnLock(() => spawnSessionRecord({
      record,
      cli,
      cfg,
      body,
      resumeArgsOverride: pickerArgs,
      replaceLive: true,
      bindOnOutputForMs: 2 * 60_000,
    }));
    scheduleBindingScanSeries([800, 2000, 4000, 8000, 15000, 30000, 60000]);
    return launched;
  }

  // Expose spawnSessionRecord globally for agent-bus internal use.
  setSpawnSessionRecord(spawnSessionRecord);

  return {
    spawnCliSession,
    spawnSessionRecord,
    spawnSessionPickerRecord,
  };
}

module.exports = {
  // pure helpers — no deps needed
  workspaceOccupancySessions,
  workspaceOccupancyLabel,
  launchCwdFor,
  resumeMode,
  buildFolderResumeArgs,
  buildPickerResumeArgs,
  buildResumeArgs,

  // factory — inject webTerminal + persistedSessions + scheduleBindingScan
  createSessionHelpers,

  // spawnSessionRecord bridge — set by createSessionHelpers, read by agent-bus handlers
  setSpawnSessionRecord,
  getSpawnSessionRecord,
};
