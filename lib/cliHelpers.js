// CLI helpers extracted from server.js — pure functions for CLI discovery,
// command resolution, PATH merging, and config decoration.
//
// Exports:
//   pickCli, findCliById, resolveCommand, spawnEnv, probeCli,
//   decorateConfigWithProbes, stripTunnelKeys, mergedUserPath
//
// mergedUserPath is computed once at require time by reading HKCU\Environment
// and merging the user PATH ahead of the system PATH.

'use strict';

const path = require('node:path');

// ── CLI pickers ────────────────────────────────────────────────────────

function pickCli(cfg, requestedId) {
  const wanted = requestedId || cfg.defaultCliId;
  return cfg.clis.find((c) => c.id === wanted) || cfg.clis[0];
}

function findCliById(cfg, id) {
  return (cfg.clis || []).find((c) => c.id === id) || null;
}

// ── command resolution ─────────────────────────────────────────────────

function quoteForPwsh(s) {
  if (s === '' || /[\s'"`$]/.test(s)) return `'${String(s).replace(/'/g, "''")}'`;
  return s;
}

function quoteForCmd(s) {
  if (s === '' || /[\s"&|<>^]/.test(s)) return `"${String(s).replace(/"/g, '""')}"`;
  return s;
}

// Resolve how to spawn a CLI command. Windows quirks:
// v1.1 — spawn strategy is now caller-controlled via cli.shell:
//   'direct' — pty.spawn(command, args). Real .exe / absolute paths only.
//              Won't find pwsh aliases / functions.
//   'pwsh'   — wrap in `pwsh.exe -NoLogo -NoExit -Command "& { cmd args }"`.
//              Loads $PROFILE → pwsh aliases / functions work.
//              Falls back to powershell.exe (5.x) if pwsh.exe absent.
//   'cmd'    — wrap in `cmd.exe /d /s /c "cmd args"`. Resolves doskey aliases
//              and PATH-only names without pwsh dependency.
function resolveCommand(commandRaw, userArgs = [], shell = 'direct') {
  if (!commandRaw) throw new Error('cli.command is empty');
  const cmd = commandRaw.replace(/^\.[\\\/]/, '');

  if (shell === 'pwsh') {
    const joined = [cmd, ...userArgs.map(quoteForPwsh)].join(' ');
    return {
      exe: 'pwsh.exe',
      prefixArgs: ['-NoLogo', '-NoExit', '-Command', `& { ${joined} }`],
      fallbackExe: 'powershell.exe',
      consumesUserArgs: true,
    };
  }

  if (shell === 'cmd') {
    const joined = [cmd, ...userArgs.map(quoteForCmd)].join(' ');
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', joined],
      consumesUserArgs: true,
    };
  }

  // shell === 'direct'
  if (path.isAbsolute(cmd)) {
    const ext = path.extname(cmd).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      return { exe: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cmd], consumesUserArgs: false };
    }
    if (ext === '.ps1') {
      return {
        exe: 'powershell.exe',
        prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd],
        consumesUserArgs: false,
      };
    }
    return { exe: cmd, prefixArgs: [], consumesUserArgs: false };
  }
  return { exe: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cmd], consumesUserArgs: false };
}

// ── PATH merge ─────────────────────────────────────────────────────────

function buildMergedUserPath() {
  if (process.platform !== 'win32') return process.env.PATH;
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'PATH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return process.env.PATH;
    const line = r.stdout.split(/\r?\n/).find((l) => /\bPATH\b/i.test(l) && /REG_(EXPAND_)?SZ/i.test(l));
    if (!line) return process.env.PATH;
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/);
    if (!m) return process.env.PATH;
    // Expand %VAR% references manually (REG_EXPAND_SZ keeps them literal).
    const userPath = m[1].replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
    const existing = (process.env.PATH || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const adds = userPath
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [];
    const seen = new Set();
    for (const p of [...adds, ...existing]) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(p);
    }
    return merged.join(';');
  } catch {
    return process.env.PATH;
  }
}

const mergedUserPath = buildMergedUserPath();

// Hand back a fresh env for spawning a child, with PATH overridden by
// our merged user PATH and any duplicate case variants of "path"
// stripped first.
function spawnEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (process.platform === 'win32') {
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === 'path') delete env[k];
    }
  }
  if (mergedUserPath) env.PATH = mergedUserPath;
  return env;
}

// ── CLI probe ──────────────────────────────────────────────────────────

const cliProbeCache = new Map();

function probeCli(command) {
  if (!command) return null;
  if (cliProbeCache.has(command)) return cliProbeCache.get(command);
  const { spawnSync } = require('node:child_process');
  let resolvedPath = null;
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where.exe' : 'which';
    const env = { ...process.env };
    if (mergedUserPath) env.PATH = mergedUserPath;
    const r = spawnSync(cmd, [command], { encoding: 'utf8', windowsHide: true, env });
    if (r.status === 0 && r.stdout) {
      resolvedPath =
        r.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0] || null;
    }
  } catch {}
  cliProbeCache.set(command, resolvedPath);
  return resolvedPath;
}

function decorateConfigWithProbes(cfg) {
  return {
    ...cfg,
    clis: (cfg.clis || []).map((c) => {
      const installPath = probeCli(c.command);
      return { ...c, installed: !!installPath, installPath };
    }),
  };
}

// ── tunnel-key stripping ───────────────────────────────────────────────

function stripTunnelKeys(cfg) {
  const rest = { ...cfg };
  delete rest.tunnel;
  delete rest.devtunnel;
  return rest;
}

module.exports = {
  pickCli,
  findCliById,
  resolveCommand,
  quoteForPwsh,
  quoteForCmd,
  spawnEnv,
  probeCli,
  decorateConfigWithProbes,
  stripTunnelKeys,
  mergedUserPath,
};
