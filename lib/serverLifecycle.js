// Server lifecycle — graceful shutdown, port reclaim, session reconciliation.
// Extracted from server.js (Sprint 31 refactor — ≤500 lines).

'use strict';
const errReport = require('./errorReport');   // Sprint 42: no silent failures


const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// ── Port lock ──────────────────────────────────────────────────────────

const PORT_LOCK_PATH = (() => {
  const { DATA_DIR } = require('./config');
  return path.join(DATA_DIR, 'port.lock');
})();

function isPidDead(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; }
}

// ── graceful shutdown ──────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(reason, { webTerminal, persistedSessions, DATA_DIR, tunnel }) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boos] shutting down · ${reason}`);

  try {  fs.unlinkSync(PORT_LOCK_PATH);  } catch (e) { errReport.report("serverLifecycle", "unlinkSync", e); }

  // 1. Ctrl+C every PTY, wait 15s for CLI to flush state.
  try {  await webTerminal.gracefulKillAll(15000);  } catch (e) { errReport.report("serverLifecycle", "gracefulKillAll", e); }

  // 2. Save active session list for auto-resume on next boot.
  try {
    const all = await persistedSessions.loadAll();
    const activeIds = all.filter((s) => s.status === 'running').map((s) => s.id);
    const AUTO_RESUME_PATH = path.join(DATA_DIR, 'active-sessions.json');
    if (activeIds.length > 0) {
      fs.writeFileSync(AUTO_RESUME_PATH, JSON.stringify({ ids: activeIds, savedAt: new Date().toISOString() }));
      console.log(`[boos] saved ${activeIds.length} active session(s) for auto-resume`);
    }
  } catch (e) { errReport.report("serverLifecycle", "log", e); }

  // 3. Mark all running sessions as exited.
  try {
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') await persistedSessions.markExited(s.id, null).catch(() => {});
    }
  } catch (e) { errReport.report("serverLifecycle", "markExited", e); }

  // 4. Stop PostgreSQL + archive + tunnel.
  // Sprint 42: PostgreSQL removed — SQLite needs no container lifecycle.
  try {  require('./archive').stopPeriodicPrune();  } catch (e) { errReport.report("serverLifecycle", "require", e); }
  try {  tunnel.stop();  } catch (e) { errReport.report("serverLifecycle", "stop", e); }

  process.exit(0);
}

// ── Port reclaim ───────────────────────────────────────────────────────

async function reclaimPortFromOldInstance(preferredPort) {
	let oldPort = null;
	let oldPid = null;

	try {
		const existingRaw = fs.readFileSync(PORT_LOCK_PATH, 'utf-8');
		const existing = JSON.parse(existingRaw);
		if (existing.pid && existing.port && !isPidDead(existing.pid)) {
			oldPort = existing.port;
			oldPid = existing.pid;
		}
	} catch (e) { errReport.report("serverLifecycle", "parse", e); }

	if (!oldPort) {
		const portInUse = await new Promise((resolve) => {
			const test = http.createServer();
			test.once('error', () => resolve(true));
			test.once('listening', () => { test.close(); resolve(false); });
			test.listen(preferredPort, '127.0.0.1');
		});
		if (portInUse) {
			oldPort = preferredPort;
			try {
				const { execSync } = require('node:child_process');
				const cmd = process.platform === 'win32'
					? `netstat -ano | findstr :${preferredPort} | findstr LISTENING`
					: `lsof -i :${preferredPort} -t`;
				const output = execSync(cmd, { encoding: 'utf-8', timeout: 2000 }).trim();
				const match = output.match(/\d+$/);
				if (match) {
					oldPid = parseInt(match[0], 10);
					console.log(`[boos] 端口 ${preferredPort} 被 PID ${oldPid} 占用 — 强制释放`);
				}
			} catch (e) { console.warn('[boos] 端口探测失败:', e.message); }
		}
	}

	if (oldPid && !isPidDead(oldPid)) {
		// try graceful shutdown via POST /api/shutdown (2s timeout).
		// Sprint 38: read shutdown token so the new token guard accepts our request.
		console.log(`[boos] port ${oldPort} occupied by PID ${oldPid} — sending shutdown signal...`);
		try {
			await new Promise((resolve) => {
				// Read the old instance's shutdown token from its data dir.
				let token = '';
				try {
					const { DATA_DIR } = require('./config');
					const tokenPath = path.join(DATA_DIR, '.shutdown-token');
					token = fs.readFileSync(tokenPath, 'utf-8').trim();
				} catch { /* old instance may not have a token file */ }
				const body = JSON.stringify({ token });
				const req = http.request({
					hostname: '127.0.0.1', port: oldPort, path: '/api/shutdown', method: 'POST', timeout: 2000,
					headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
				}, (res) => { res.resume(); res.on('end', resolve); });
				req.on('error', resolve);
				req.on('timeout', () => { req.destroy(); resolve(); });
				req.write(body);
				req.end();
			});
		} catch (e) { errReport.report("serverLifecycle", "end", e); }
		// 等 2s 确认进程是否退出。
		await new Promise(r => setTimeout(r, 2000));
		if (isPidDead(oldPid)) { console.log(`[boos] PID ${oldPid} 已退出`); }
	}

	if (oldPid && !isPidDead(oldPid)) {
		console.warn(`[boos] PID ${oldPid} 未响应 — 强制终止 (进程树)...`);
		try {
			if (process.platform === 'win32') {
				// taskkill /T kills the WHOLE process tree. process.kill(SIGKILL)
				// alone leaves the old server's PTY children (claude.exe) alive —
				// the next boot crash-reconnects the same sessions, producing
				// TWO claude processes per session (old orphan + new spawn)
				// racing on the same .mcp.json/transcripts → native crash.
				require('node:child_process').execSync(`taskkill /PID ${oldPid} /T /F`, { stdio: 'ignore', timeout: 5000 });
			} else {
				process.kill(oldPid, 'SIGKILL');
			}
		} catch (e) { errReport.report("serverLifecycle", "kill", e); }
		await new Promise(r => setTimeout(r, 2000));
		if (!isPidDead(oldPid)) {
			console.warn(`[boos] 无法终止 PID ${oldPid} — 端口可能仍被占用`);
		}
	}

	try {  fs.unlinkSync(PORT_LOCK_PATH);  } catch (e) { errReport.report("serverLifecycle", "unlinkSync", e); }
}

// ── Session reconciliation on boot ─────────────────────────────────────

async function reconcileSessionsOnBoot({ persistedSessions, webTerminal, loadConfig, DATA_DIR, spawnSessionRecord }) {
  // Normalize legacy records, mark stale "running" as exited.
  await persistedSessions.normalizeStore();
  let all = await persistedSessions.loadAll();
  for (const s of all) {
    if (s.status === 'running') await persistedSessions.markExited(s.id, null);
  }
  all = await persistedSessions.loadAll();

  // Dedup ghost sessions (same cliId+cwd, one has cliSessionId, other doesn't).
  const seen = new Map();
  for (const s of all) {
    if (s.status === 'running' || s.deletedAt) continue;
    const key = `${s.cliId}|${(s.cwd || '').toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { best: null, ghosts: [] });
    const entry = seen.get(key);
    if (s.cliSessionId) {
      if (entry.best && entry.best.cliSessionId) {
        if ((entry.best.lastActiveAt || 0) >= (s.lastActiveAt || 0)) entry.ghosts.push(s);
        else { entry.ghosts.push(entry.best); entry.best = s; }
      } else { entry.best = s; }
    } else { entry.ghosts.push(s); }
  }
  let deduped = 0;
  for (const [, entry] of seen) {
    if (!entry.best || !entry.best.cliSessionId) continue;
    for (const ghost of entry.ghosts) {
      if (!ghost.cliSessionId && ghost.status !== 'running') {
        await persistedSessions.remove(ghost.id);
        deduped++;
      }
    }
  }
  if (deduped > 0) console.log(`[boos] dedup: soft-deleted ${deduped} ghost session(s)`);

  // Revive sessions with surviving PTYs.
  let revived = 0;
  try {
    const liveTermIds = new Set(webTerminal.list().filter((t) => !t.exitedAt).map((t) => t.id));
    for (const s of all) {
      if (s.status === 'exited' && liveTermIds.has(s.id)) {
        try {
          const term = webTerminal.get(s.id);
          await persistedSessions.markRunning(s.id, term ? term.pid : null);
          revived++;
        } catch (e) { errReport.report("serverLifecycle", "markRunning", e); }
      }
    }
  } catch (e) { errReport.report("serverLifecycle", "markRunning", e); }
  if (revived > 0) console.log(`[boos] auto-resume: ${revived} session(s) with surviving PTYs restored to running`);

  // Auto-resume sessions from previous run (graceful-shutdown manifest).
  let resumedFromManifest = 0;
  try {
    const AUTO_RESUME_PATH = path.join(DATA_DIR, 'active-sessions.json');
    const raw = fs.readFileSync(AUTO_RESUME_PATH, 'utf-8');
    const { ids } = JSON.parse(raw);
    if (Array.isArray(ids) && ids.length > 0) {
      console.log(`[boos] auto-resume: restoring ${ids.length} session(s) from previous run...`);
      const cfg = await loadConfig();
      const cliHelpers = require('./cliHelpers');
      // Sprint 42: resume sessions in PARALLEL — sequential spawn made boot
      // slow when many sessions were active (total = N × spawn latency).
      // Injection staggered (i*400ms) so N setTimeouts don't fire in the
      // same tick — native pty.write() bursts crash Windows ConPTY.
      await Promise.allSettled(ids.map(async (id, i) => {
        try {
          const record = await persistedSessions.get(id);
          if (!record) return;
          const live = webTerminal.get(record.id);
          if (live && !live.exitedAt) return;
          if (record.manualStopped) return;
          const cli = cliHelpers.findCliById(cfg, record.cliId);
          if (!cli) return;
          await spawnSessionRecord({ record, cli, cfg, body: {}, resume: true, skipStartupInjection: true });
          // Schedule check_inbox injection at T+8s (Claude needs time to init MCP/SSE/Ink), staggered.
          setTimeout(() => {
            try {
              const { _injectCommand } = require('./agentBus/notificationsWake');
              _injectCommand(record.id, 'check_inbox[BOOS]');
              console.log('[boos] boot injection: check_inbox sent to', record.id.slice(-8));
            } catch (e) { console.warn('[boos] boot injection failed:', record.id.slice(-8), e.message); }
          }, 8000 + i * 400);
          resumedFromManifest++;
        } catch (e) { console.warn(`[boos] auto-resume: failed ${id.slice(-8)}:`, e.message); }
      }));
      if (resumedFromManifest > 0) console.log(`[boos] auto-resume: restored ${resumedFromManifest}/${ids.length} session(s)`);
    }
    try {  fs.unlinkSync(AUTO_RESUME_PATH);  } catch (e) { errReport.report("serverLifecycle", "unlinkSync", e); }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[boos] auto-resume: could not restore sessions:', e.message);
  }

  // Sprint 38 bugfix: Crash-restart fallback — auto-resume managed agent
  // sessions even when active-sessions.json is missing (abnormal exit).
  // On a crash, gracefulShutdown never runs, so the manifest is never
  // written.  We fall back to scanning all sessions: any that has a
  // cliSessionId (Claude --resume UUID), is not manually stopped, and
  // has no live PTY is auto-resumed in sequence (not parallel) to
  // prevent resource storms.  skipStartupInjection=true prevents the
  // 8s setTimeout injection race with the implicit auto-resume flow.
  try {
    const allSessions = await persistedSessions.loadAll();
    // Sprint 38: Filter by pending inbox tasks — the only reliable signal.
    // lastActiveAt is unreliable (pg-sync touches all sessions), and
    // cliSessionId alone gates in 20+ stale sessions.  If an agent has
    // pending work, they must be auto-resumed; otherwise leave them dead.
    let agentsWithWork = new Set();
    try {
      const inboxDir = path.join(DATA_DIR, 'agent-bus', 'inbox');
      const inboxFiles = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.endsWith('.bak'));
      for (const f of inboxFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf-8'));
          const pending = (data.pending || []).length;
          const inProgress = (data.in_progress || []).length;
          if (pending + inProgress > 0) {
            agentsWithWork.add(f.replace('.json', ''));
          }
        } catch (e) { errReport.report("serverLifecycle", "add", e); }
      }
      console.log(`[boos] auto-resume: ${agentsWithWork.size} agent(s) with pending inbox tasks`);
    } catch (e) { errReport.report("serverLifecycle", "log", e); }
    const managedDead = allSessions.filter(s =>
      s.cliSessionId && !s.deletedAt && !s.manualStopped &&
      (!webTerminal.get(s.id) || webTerminal.get(s.id).exitedAt) &&
      agentsWithWork.has(s.cliSessionId)
    );
    if (managedDead.length > 0) {
      console.log(`[boos] auto-resume (crash fallback): ${managedDead.length} managed agent(s) with dead PTY — resuming in sequence...`);
      const cfg = await loadConfig();
      const cliHelpers = require('./cliHelpers');
      let crashResumed = 0;
      const spawnedIds = [];
      for (const record of managedDead) {
        try {
          const cli = cliHelpers.findCliById(cfg, record.cliId);
          if (!cli) { console.warn(`[boos] auto-resume: CLI ${record.cliId} not found for ${record.id.slice(-8)}`); continue; }
          console.log(`[boos] auto-resume: crash-reconnect agent session ${record.id.slice(-8)} (${record.cliId})`);
          await spawnSessionRecord({ record, cli, cfg, body: {}, resume: true, skipStartupInjection: true });
          spawnedIds.push(record.id);
          crashResumed++;
        } catch (e) { console.warn(`[boos] auto-resume: crash-reconnect failed ${record.id.slice(-8)}:`, e.message); }
      }
      // Sprint 42 crash fix: schedule ALL boot injections AFTER every spawn
      // completed. The old code registered each setTimeout right after its
      // own spawn — but spawns are serialized (each takes 3-8s), so the
      // first injection (T+8s) fired while later spawns were still running.
      // Concurrent node-pty spawn+write crashes the process natively (no JS
      // stack, exit 1). Staggered after the loop: no spawn is in flight.
      spawnedIds.forEach((id, i) => {
        setTimeout(() => {
          try {
            const { _injectCommand } = require('./agentBus/notificationsWake');
            const errReport = require("./errorReport");
            _injectCommand(id, 'check_inbox[BOOS]');
            console.log('[boos] boot injection: check_inbox sent to', id.slice(-8));
          } catch (e) { console.warn('[boos] boot injection failed:', id.slice(-8), e.message); }
        }, 8000 + i * 400);
      });
      if (crashResumed > 0) console.log(`[boos] auto-resume: crash-reconnected ${crashResumed}/${managedDead.length} agent session(s)`);
    }
  } catch (e) { console.warn('[boos] auto-resume: crash fallback error:', e.message); }
}

module.exports = { gracefulShutdown, reclaimPortFromOldInstance, reconcileSessionsOnBoot, PORT_LOCK_PATH, isPidDead };
