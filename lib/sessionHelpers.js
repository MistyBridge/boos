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

const path = require('node:path');
const os = require('node:os');

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
    } catch {}
    home = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (!(await ensureCodexLightTheme(home))) return [];
    return ['-c', 'tui.theme="boos-light"'];
  } catch {
    return [];
  }
}

// ── factory ────────────────────────────────────────────────────────────

function createSessionHelpers({
  webTerminal,
  persistedSessions,
  resolveCommand,
  spawnEnv,
  scheduleBindingScan,
  scheduleBindingScanSeries,
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
          } catch {}
          if (onOutput) {
            try {
              onOutput();
            } catch {}
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

  async function spawnSessionRecord({
    record,
    cli,
    cfg,
    body,
    resume = false,
    resumeArgsOverride = null,
    replaceLive = false,
    bindOnOutputForMs = 0,
    extraCliArgs = [],
  }) {
    const live = webTerminal.get(record.id);
    if (live && !live.exitedAt) {
      if (!replaceLive) {
        if (record.status !== 'running' || record.pid !== live.meta.pid) {
          try {
            await persistedSessions.markRunning(record.id, live.meta.pid);
          } catch {}
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

    const entry = spawnCliSession({
      cli,
      cwd: record.cwd,
      sessionId: record.id,
      meta: { title: record.title || record.workspace, workspace: record.workspace, cwd: record.cwd },
      extraArgs: [...extraCliArgs, ...themeArgs, ...folderResumeArgs],
      theme: body && body.theme,
      cols: body && body.cols,
      rows: body && body.rows,
      onOutput,
    });
    await persistedSessions.markRunning(record.id, entry.meta.pid);
    scheduleBindingScan();
    return { id: record.id, pid: entry.meta.pid, cliId: cli.id };
  }

  // ── spawn a session in picker mode ──────────────────────────────────

  async function spawnSessionPickerRecord({ record, cli, cfg, body }) {
    const pickerArgs = buildPickerResumeArgs(cli);
    const launched = await spawnSessionRecord({
      record,
      cli,
      cfg,
      body,
      resumeArgsOverride: pickerArgs,
      replaceLive: true,
      bindOnOutputForMs: 2 * 60_000,
    });
    scheduleBindingScanSeries([800, 2000, 4000, 8000, 15000, 30000, 60000]);
    return launched;
  }

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
};
