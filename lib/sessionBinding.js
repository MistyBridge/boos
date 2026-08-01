// Bind a boos session to the upstream CLI's own session id.
//
// Each CLI leaves runtime traces keyed by process PID — we snapshot the
// process tree, walk descendants of the PTY pid, and match CLI-specific
// per-pid traces against any descendant.
//
// Split across 2 modules (Sprint 31 — ≤500 lines each):
//   sessionBinding.js       — createScanner() + binding scan loop (this file)
//   sessionBindingDetect.js — per-CLI detectors + process-tree utils

'use strict';

const path = require('node:path');
const detectMod = require('./sessionBindingDetect');

function bindingCwdKey(type, cwd) {
  let resolved = '';
  try { resolved = path.resolve(String(cwd || '')).toLowerCase(); }
  catch { resolved = String(cwd || '').toLowerCase(); }
  return `${type || 'unknown'}\0${resolved}`;
}

function createScanner({ persistedSessions, webTerminal, loadConfig }) {
  let bindingScanRunning = false;

  async function scanSessionBindings() {
    if (bindingScanRunning) return;
    if (!webTerminal.available) return;
    bindingScanRunning = true;
    try {
      const all = await persistedSessions.loadAll();
      const running = all.filter((s) => s && s.status === 'running' && s.pid);
      if (!running.length) return;
      let cfg;
      try { cfg = await loadConfig(); } catch { return; }
      const typeById = new Map((cfg.clis || []).map((c) => [c.id, c.type]));
      const bindable = running.filter((s) => detectMod.supports(typeById.get(s.cliId)));
      if (!bindable.length) return;

      const groupCounts = new Map();
      const claimedCodexIds = new Map();
      for (const s of bindable) {
        const type = typeById.get(s.cliId);
        const key = bindingCwdKey(type, s.cwd);
        groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
        if (type === 'codex' && s.cliSessionId) {
          if (!claimedCodexIds.has(key)) claimedCodexIds.set(key, new Set());
          claimedCodexIds.get(key).add(String(s.cliSessionId));
        }
      }

      const tree = await detectMod.snapshotProcessTree();
      const ordered = [...bindable].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      for (const s of ordered) {
        const type = typeById.get(s.cliId);
        const key = bindingCwdKey(type, s.cwd);
        const duplicateCodexCwd = type === 'codex' && (groupCounts.get(key) || 0) > 1;
        if (duplicateCodexCwd && s.cliSessionId) continue;

        const live = webTerminal.get(s.id);
        const ptyPid = live && !live.exitedAt && live.meta && live.meta.pid ? live.meta.pid : s.pid;
        const detectOpts = {};
        if (duplicateCodexCwd) {
          detectOpts.excludeIds = [...(claimedCodexIds.get(key) || new Set())];
        }

        let result = null;
        try { result = await detectMod.detect(type, ptyPid, s.cwd, tree, detectOpts); } catch {}
        const sid = result ? result.sessionId : null;

        if (sid && sid !== s.cliSessionId) {
          const prev = s.cliSessionId;
          try {
            await persistedSessions.setCliSessionId(s.id, sid);
            if (result.projectSlug) {
              await persistedSessions.setProjectSlug(s.id, result.projectSlug);
            }
          } catch {}
          if (duplicateCodexCwd) {
            if (!claimedCodexIds.has(key)) claimedCodexIds.set(key, new Set());
            claimedCodexIds.get(key).add(String(sid));
          }
          console.log(`[boos] binding ${prev ? 'changed' : 'bound'} · session ${s.id} (${s.cliId}) · ${prev || '(none)'} -> ${sid}`);

          // Sprint 32: After binding, update MCP filesystem config based on
          // agent identity + folder agentLevels. This is the enforcement point
          // for the sidebar gear icon's PM/PMO/SE permission settings.
          try {
            const store = require('./agentBus/store');
            // Sprint 33: Lookup identity by cliSessionId (agent's UID).
            const identity = s.cliSessionId ? store.getIdentity({ uid: s.cliSessionId }) : null;
            if (identity) {
              const agent = store.getAgent(s.cliSessionId);
              if (agent) {
                const sandbox = require('./sandbox');
                const fsConfig = await sandbox.getFilesystemMcpConfig({
                  folderId: s.folderId,
                  agentUid: agent.uid,
                });
                const mcpPath = path.join(s.cwd, '.mcp.json');
                try {
                  const raw = await require('node:fs/promises').readFile(mcpPath, 'utf-8');
                  const mcp = JSON.parse(raw);
                  mcp.mcpServers = mcp.mcpServers || {};
                  mcp.mcpServers.filesystem = fsConfig;
                  await require('node:fs/promises').writeFile(mcpPath, JSON.stringify(mcp, null, 2), 'utf-8');
                  console.log(`[boos] sandbox updated · session ${s.id} · agent ${agent.uid} (${agent.role})`);
                } catch { /* .mcp.json not writable or doesn't exist yet — non-fatal */ }
              }
            }
          } catch { /* sandbox update is best-effort */ }
        } else if (result && result.projectSlug && !s.projectSlug) {
          try { await persistedSessions.setProjectSlug(s.id, result.projectSlug); } catch {}
        }
      }

      // Incremental sync to PostgreSQL after each scan cycle.
      try {
        const pg = require('./postgres');
        const pool = pg.getPool();
        if (pool) {
          const syncable = (await persistedSessions.loadAll()).filter(s =>
            typeById.get(s.cliId) === 'claude' && s.cliSessionId && s.projectSlug && s.cwd);
          if (syncable.length) {
            const { syncAllRunning } = require('./conversationSync');
            const syncResult = await syncAllRunning(pool, syncable);
            if (syncResult.totalTurns > 0) {
              console.log(`[boos] pg-sync: ${syncResult.totalTurns} turns across ${syncResult.sessions} sessions`);
            }
          }
        }
      } catch {}
    } finally { bindingScanRunning = false; }
  }

  function scheduleBindingScan(delayMs = 4000) {
    setTimeout(() => { scanSessionBindings().catch(() => {}); }, delayMs);
  }

  function scheduleBindingScanSeries(delaysMs) {
    for (const delay of delaysMs || []) scheduleBindingScan(delay);
  }

  function startPeriodicScan() {
    if (process.env.BOOS_NO_BIND_SCAN === '1') return null;
    scanSessionBindings().catch(() => {});
    const timer = setInterval(() => { scanSessionBindings().catch(() => {}); }, 10_000);
    console.log('[boos] session-id binding scanner active (10s)');
    return timer;
  }

  return { scanSessionBindings, scheduleBindingScan, scheduleBindingScanSeries, startPeriodicScan };
}

module.exports = {
  snapshotProcessTree: detectMod.snapshotProcessTree,
  descendantsOf: detectMod.descendantsOf,
  detect: detectMod.detect,
  supports: detectMod.supports,
  bindingCwdKey,
  createScanner,
};
