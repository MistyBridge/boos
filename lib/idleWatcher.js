// Idle detection — single-process watchdog that gracefully shuts down BOOS
// after a configurable period of inactivity.
//
// Exports:
//   start({ persistedSessions, lifecycleState, heartbeatTimeoutMs, idleTimeoutMs })
//     → returns the watcher (with .status() for /api/keep-alive/status)
//   status() → { keepAlive, activeSessions, lastHeartbeatMs, mcpConnections,
//                idleTimeMs, willShutdownAfterMs, ... }
//
// Check runs every 30s. Server is "active" if ANY of:
//   1. At least one persistedSessions record shows status === 'running'
//   2. A frontend heartbeat arrived within the last 5 min
//   3. Agent-bus MCP has ≥1 connected SSE client
//
// If none are true → idle timer accumulates. When idle exceeds
// idleTimeoutMs (default 30 min), gracefulShutdown fires.
// BOOS_KEEP_ALIVE=1 disables ALL auto-shutdown.

'use strict';

const IDLE_CHECK_MS = 30_000;                // check interval
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000; // 30 min
const HEARTBEAT_WINDOW_MS = 5 * 60_000;      // 5 min — a heartbeat this recent counts as "active"

function createIdleWatcher({
  webTerminal,
  lifecycleState,
  gracefulShutdown,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  // Allow environment override
  const effectiveTimeout = Number(process.env.BOOS_IDLE_TIMEOUT) || idleTimeoutMs;

  let idleSince = null;       // timestamp when idle period began, null = active
  let mcpConnectionCount = 0; // set externally by agent-bus transport
  let timer = null;
  let stopped = false;

  function check() {
    if (stopped) return;

    // BOOS_KEEP_ALIVE=1 → never auto-stop
    if (process.env.BOOS_KEEP_ALIVE === '1') {
      idleSince = null;
      return;
    }

    const now = Date.now();

    // Criterion 1: any running PTY session? webTerminal.list() is synchronous.
    const hasRunningSession = (() => {
      try {
        return webTerminal.list().some((t) => !t.exitedAt);
      } catch { return false; }
    })();

    // Criterion 2: recent heartbeat?
    const heartbeatAge = now - (lifecycleState.lastHeartbeat || 0);
    const hasRecentHeartbeat = heartbeatAge < HEARTBEAT_WINDOW_MS;

    // Criterion 3: active MCP connections?
    const hasMcpConnections = mcpConnectionCount > 0;

    const isActive = hasRunningSession || hasRecentHeartbeat || hasMcpConnections;

    if (isActive) {
      idleSince = null;
    } else {
      if (idleSince === null) {
        idleSince = now;
        console.log('[boos] idleWatcher: server is idle (no sessions, no heartbeat, no MCP connections)');
      }
      const idleDuration = now - idleSince;
      if (idleDuration >= effectiveTimeout) {
        const mins = Math.round(idleDuration / 60_000);
        console.log(`[boos] idleWatcher: idle for ${mins} min → shutting down`);
        gracefulShutdown(`idle timeout (${mins} min)`);
      }
    }
  }

  function start() {
    if (stopped) return;
    check(); // immediate first check
    timer = setInterval(check, IDLE_CHECK_MS);
    timer.unref(); // don't keep process alive just for this timer
    console.log(`[boos] idleWatcher started (check every ${IDLE_CHECK_MS / 1000}s, timeout ${Math.round(effectiveTimeout / 60_000)}min)`);
  }

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function status() {
    const now = Date.now();
    const idleTimeMs = idleSince ? (now - idleSince) : 0;
    const willShutdownAfterMs = idleSince
      ? Math.max(0, effectiveTimeout - idleTimeMs)
      : effectiveTimeout;

    return {
      keepAlive: process.env.BOOS_KEEP_ALIVE === '1',
      activeSessions: (() => { try { return webTerminal.list().filter((t) => !t.exitedAt).length; } catch { return 0; } })(),
      lastHeartbeatMs: now - (lifecycleState.lastHeartbeat || now),
      mcpConnections: mcpConnectionCount,
      idleTimeMs,
      willShutdownAfterMs,
      idleTimeoutMs: effectiveTimeout,
      heartbeatWindowMs: HEARTBEAT_WINDOW_MS,
    };
  }

  // Allow transport.js to update MCP connection count
  function setMcpConnectionCount(n) {
    mcpConnectionCount = Math.max(0, n);
  }

  return { start, stop, status, setMcpConnectionCount, check };
}

module.exports = { createIdleWatcher, IDLE_CHECK_MS, DEFAULT_IDLE_TIMEOUT_MS, HEARTBEAT_WINDOW_MS };
