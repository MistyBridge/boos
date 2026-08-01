// Server lifecycle — graceful shutdown, port reclaim, session reconciliation.
// Extracted from server.js (Sprint 31 refactor — ≤500 lines).

'use strict';

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

  try { fs.unlinkSync(PORT_LOCK_PATH); } catch {}

  // 1. Ctrl+C every PTY, wait 15s for CLI to flush state.
  try { await webTerminal.gracefulKillAll(15000); } catch {}

  // 2. Save active session list for auto-resume on next boot.
  try {
    const all = await persistedSessions.loadAll();
    const activeIds = all.filter((s) => s.status === 'running').map((s) => s.id);
    const AUTO_RESUME_PATH = path.join(DATA_DIR, 'active-sessions.json');
    if (activeIds.length > 0) {
      fs.writeFileSync(AUTO_RESUME_PATH, JSON.stringify({ ids: activeIds, savedAt: new Date().toISOString() }));
      console.log(`[boos] saved ${activeIds.length} active session(s) for auto-resume`);
    }
  } catch {}

  // 3. Mark all running sessions as exited.
  try {
    const all = await persistedSessions.loadAll();
    for (const s of all) {
      if (s.status === 'running') await persistedSessions.markExited(s.id, null).catch(() => {});
    }
  } catch {}

  // 4. Stop PostgreSQL + archive + tunnel.
  try { await require('./postgres').stopContainer(); } catch {}
  try { require('./archive').stopPeriodicPrune(); } catch {}
  try { tunnel.stop(); } catch {}

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
	} catch {}

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
		// 尝试优雅关闭 (POST /api/shutdown)，超时 2s。
		console.log(`[boos] 端口 ${oldPort} 被 PID ${oldPid} 占用 — 发送关闭信号...`);
		try {
			await new Promise((resolve) => {
				const req = http.request({
					hostname: '127.0.0.1', port: oldPort, path: '/api/shutdown', method: 'POST', timeout: 2000,
				}, (res) => { res.resume(); res.on('end', resolve); });
				req.on('error', resolve);
				req.on('timeout', () => { req.destroy(); resolve(); });
				req.end();
			});
		} catch {}
		// 等 2s 确认进程是否退出。
		await new Promise(r => setTimeout(r, 2000));
		if (isPidDead(oldPid)) { console.log(`[boos] PID ${oldPid} 已退出`); }
	}

	if (oldPid && !isPidDead(oldPid)) {
		console.warn(`[boos] PID ${oldPid} 未响应 — 强制终止...`);
		try { process.kill(oldPid, 'SIGKILL'); } catch {}
		await new Promise(r => setTimeout(r, 2000));
		if (!isPidDead(oldPid)) {
			console.warn(`[boos] 无法终止 PID ${oldPid} — 端口可能仍被占用`);
		}
	}

	try { fs.unlinkSync(PORT_LOCK_PATH); } catch {}
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
        } catch {}
      }
    }
  } catch {}
  if (revived > 0) console.log(`[boos] auto-resume: ${revived} session(s) with surviving PTYs restored to running`);

  // Auto-resume sessions from previous run.
  try {
    const AUTO_RESUME_PATH = path.join(DATA_DIR, 'active-sessions.json');
    const raw = fs.readFileSync(AUTO_RESUME_PATH, 'utf-8');
    const { ids } = JSON.parse(raw);
    if (Array.isArray(ids) && ids.length > 0) {
      console.log(`[boos] auto-resume: restoring ${ids.length} session(s) from previous run...`);
      const cfg = await loadConfig();
      const cliHelpers = require('./cliHelpers');
      let resumed = 0;
      for (const id of ids) {
        try {
          const record = await persistedSessions.get(id);
          if (!record) continue;
          const live = webTerminal.get(record.id);
          if (live && !live.exitedAt) continue;
          if (record.manualStopped) continue;
          const cli = cliHelpers.findCliById(cfg, record.cliId);
          if (!cli) continue;
          await spawnSessionRecord({ record, cli, cfg, body: {}, resume: true });
          resumed++;
        } catch (e) { console.warn(`[boos] auto-resume: failed ${id.slice(-8)}:`, e.message); }
      }
      if (resumed > 0) console.log(`[boos] auto-resume: restored ${resumed}/${ids.length} session(s)`);
    }
    try { fs.unlinkSync(AUTO_RESUME_PATH); } catch {}
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[boos] auto-resume: could not restore sessions:', e.message);
  }
}

module.exports = { gracefulShutdown, reclaimPortFromOldInstance, reconcileSessionsOnBoot, PORT_LOCK_PATH, isPidDead };
