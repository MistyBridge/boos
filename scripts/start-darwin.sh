#!/bin/bash
# BOOS macOS background daemon launcher.
#
# Usage:
#   bash start-darwin.sh              Start BOOS as background daemon
#   bash start-darwin.sh status       Show daemon status (PID, port, uptime)
#   bash start-darwin.sh stop         Stop the daemon gracefully
#   bash start-darwin.sh restart      Stop + start
#
# What this does:
#   1. Starts server.js via `node` in background with nohup + disown
#   2. Redirects stdout/stderr to ~/.boos/server.log
#   3. Writes PID to ~/.boos/pid for status/stop
#   4. Waits up to 5s for the health endpoint to respond
#
# Auto-launched by install-darwin.sh (boos:// protocol handler) and
# can be invoked manually for headless/server setups.

set -euo pipefail

BOOS_HOME="${BOOS_HOME:-$HOME/.boos}"
PID_FILE="$BOOS_HOME/pid"
LOG_FILE="$BOOS_HOME/server.log"
BOOS_PORT="${BOOS_PORT:-7777}"
HEALTH_URL="http://127.0.0.1:$BOOS_PORT/api/health"
CMD="${1:-start}"

log()  { echo "[boos daemon] $*"; }
warn() { echo "[boos daemon] WARN: $*" >&2; }

# ── find boos server.js ──────────────────────────────────────────────

find_server_js() {
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo /usr/local)"
  local candidate="$npm_prefix/lib/node_modules/@MistyBridge/boos/server.js"
  if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi

  # Homebrew (Apple Silicon).
  candidate="/opt/homebrew/lib/node_modules/@MistyBridge/boos/server.js"
  if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi

  # Homebrew (Intel).
  candidate="/usr/local/lib/node_modules/@MistyBridge/boos/server.js"
  if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi

  # NVM / n / fnm — follow node binary path.
  if command -v node > /dev/null 2>&1; then
    local node_dir
    node_dir="$(dirname "$(dirname "$(command -v node)")")"
    candidate="$node_dir/lib/node_modules/@MistyBridge/boos/server.js"
    if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi
  fi

  return 1
}

# ── check if daemon is running ───────────────────────────────────────

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  if curl -sf --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

# ── status ───────────────────────────────────────────────────────────

cmd_status() {
  if is_running; then
    local pid="unknown" port="$BOOS_PORT"
    if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE")"; fi
    local health_json uptime
    health_json="$(curl -sf --max-time 2 "$HEALTH_URL" 2>/dev/null || echo '{}')"
    uptime="$(echo "$health_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("uptime","?"))' 2>/dev/null || echo '?')"
    log "RUNNING · pid=$pid port=$port uptime=${uptime}s"
    return 0
  else
    log "STOPPED"
    return 1
  fi
}

# ── start ────────────────────────────────────────────────────────────

cmd_start() {
  if is_running; then
    log "already running"
    cmd_status
    return 0
  fi

  mkdir -p "$BOOS_HOME"

  local server_js
  server_js="$(find_server_js)" || {
    warn "server.js not found. Is @MistyBridge/boos installed globally?"
    warn "  npm install -g @MistyBridge/boos"
    return 1
  }
  log "server.js: $server_js"

  rm -f "$PID_FILE"

  nohup node "$server_js" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  log "started · pid=$pid · log=$LOG_FILE"

  # Wait for health endpoint (up to 5s).
  local waited=0
  while [ $waited -lt 50 ]; do
    if curl -sf --max-time 1 "$HEALTH_URL" > /dev/null 2>&1; then
      log "health check OK after ${waited}0ms"
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  if [ $waited -ge 50 ]; then
    warn "health check timed out after 5s — check $LOG_FILE"
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    warn "process exited immediately — check $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi

  disown "$pid" 2>/dev/null || true
  log "daemon ready · http://127.0.0.1:$BOOS_PORT"
}

# ── stop ─────────────────────────────────────────────────────────────

cmd_stop() {
  if ! is_running; then
    log "not running"
    rm -f "$PID_FILE"
    return 0
  fi

  # Graceful via POST /api/shutdown.
  curl -sf --max-time 5 -X POST "${HEALTH_URL%/health}/shutdown" > /dev/null 2>&1 || true

  # Wait for exit (up to 10s).
  local waited=0
  while [ $waited -lt 100 ] && is_running; do
    sleep 0.1
    waited=$((waited + 1))
  done

  if is_running; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      warn "force killing pid=$pid"
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$PID_FILE"
  log "stopped"
}

# ── main ─────────────────────────────────────────────────────────────

case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; sleep 1; cmd_start ;;
  status)  cmd_status ;;
  *)
    echo "Usage: bash start-darwin.sh {start|stop|restart|status}"
    exit 1
    ;;
esac
