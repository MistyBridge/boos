// Config + CLI test routes.
// Replaces inline handlers in server.js L569–664.
//
// register(app, deps)
//   deps: { asyncH, loadConfig, saveConfig, decorateConfigWithProbes,
//           stripTunnelKeys, spawnEnv }

'use strict';

function register(app, { asyncH, loadConfig, saveConfig, decorateConfigWithProbes, stripTunnelKeys, spawnEnv }) {

  // ---- config ----
  app.get('/api/config', asyncH(async (_req, res) => {
    res.json(decorateConfigWithProbes(stripTunnelKeys(await loadConfig())));
  }));

  app.put('/api/config', asyncH(async (req, res) => {
    const body = { ...(req.body || {}) };
    delete body.tunnel;
    delete body.devtunnel;
    res.json(decorateConfigWithProbes(stripTunnelKeys(await saveConfig(body))));
  }));

  // ---- CLI probe / test ----
  app.post('/api/clis/test', asyncH(async (req, res) => {
    const { spawn } = require('node:child_process');
    const body = req.body || {};
    const command = String(body.command || '').trim();
    const shell = ['direct', 'pwsh', 'cmd'].includes(body.shell) ? body.shell : 'direct';
    const type = ['claude', 'codex', 'copilot', 'other'].includes(body.type) ? body.type : 'other';
    if (!command) return res.status(400).json({ error: 'command required' });

    let exe, args;
    const cmd = command.replace(/^\.[\\\/]/, '');
    const versionArg = '--version';
    if (shell === 'pwsh') {
      const joined = `& ${/[\s'"\`$]/.test(cmd) ? `'${cmd.replace(/'/g, "''")}'` : cmd} ${versionArg}`;
      exe = 'pwsh.exe';
      args = ['-NoLogo', '-Command', joined];
    } else if (shell === 'cmd') {
      exe = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', `${cmd} ${versionArg}`];
    } else if (require('node:path').isAbsolute(cmd)) {
      const path = require('node:path');
      const ext = path.extname(cmd).toLowerCase();
      if (ext === '.cmd' || ext === '.bat') {
        exe = process.env.ComSpec || 'cmd.exe';
        args = ['/d', '/s', '/c', cmd, versionArg];
      } else if (ext === '.ps1') {
        exe = 'powershell.exe';
        args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd, versionArg];
      } else {
        exe = cmd;
        args = [versionArg];
      }
    } else {
      exe = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', cmd, versionArg];
    }

    const t0 = Date.now();
    let stdout = '', stderr = '', exitCode = null, timedOut = false, spawnError = null;
    try {
      const child = spawn(exe, args, { env: spawnEnv(), windowsHide: true });
      const killer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, 5000);
      child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 8192) stdout = stdout.slice(0, 8192); });
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(0, 8192); });
      exitCode = await new Promise((resolve, reject) => {
        child.on('exit', (code) => { clearTimeout(killer); resolve(code); });
        child.on('error', (err) => { clearTimeout(killer); reject(err); });
      });
    } catch (e) {
      spawnError = String(e && e.message || e);
    }
    const durationMs = Date.now() - t0;

    const out = (stdout + '\n' + stderr).toLowerCase();
    const PATTERNS = {
      claude:  /claude/,
      codex:   /codex|openai/,
      copilot: /copilot/,
    };
    const matchedType = type === 'other' ? null : (PATTERNS[type] ? PATTERNS[type].test(out) : null);
    const ok = !spawnError && !timedOut && exitCode === 0;
    res.json({
      ok, exitCode, durationMs, timedOut, spawnError,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      matchedType,
      expectedType: type,
      spawned: { exe, args },
    });
  }));
}

module.exports = { register };
