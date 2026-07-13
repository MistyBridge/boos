#!/bin/bash
# BOOS cross-platform launcher — macOS / Linux wake-on-click entry point.
#
# Called by:
#   macOS:  ~/Library/Application Support/boos/launcher.sh  (from boos:// handler)
#   Linux:  ~/.local/share/boos/launcher.sh                  (from .desktop Exec)
#
# Logic (matches Windows launcher.vbs behaviour):
#   1. Probe localhost:{BOOS_PORT}/api/health.
#   2. If running → open the frontend in default browser.
#   3. If not running → spawn boos backend (hidden), then open frontend.
#
# Usage: launcher.sh [boos://start]   (URL argument is decoded but unused for now)

set -euo pipefail

URL="${1:-boos://start}"
BOOS_PORT="${BOOS_PORT:-7777}"
FRONTEND_URL="https://MistyBridge.github.io/boos/"

# ── helper: open browser ────────────────────────────────────────────

_open_browser() {
  local url="$1"
  case "$(uname -s)" in
    Darwin)
      open "$url" 2>/dev/null &
      ;;
    Linux)
      if command -v xdg-open > /dev/null 2>&1; then
        xdg-open "$url" 2>/dev/null &
      elif command -v gnome-open > /dev/null 2>&1; then
        gnome-open "$url" 2>/dev/null &
      elif command -v kde-open > /dev/null 2>&1; then
        kde-open "$url" 2>/dev/null &
      else
        echo "[boos launcher] no browser command found" >&2
        exit 1
      fi
      ;;
    *)
      echo "[boos launcher] unsupported platform: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

# ── probe BOOS backend ──────────────────────────────────────────────

HEALTH_URL="http://127.0.0.1:${BOOS_PORT}/api/health"

if command -v curl > /dev/null 2>&1; then
  if curl -sf --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
    # Already running — just open frontend.
    _open_browser "$FRONTEND_URL"
    exit 0
  fi
else
  # Fallback: try with wget if curl isn't available.
  if command -v wget > /dev/null 2>&1; then
    if wget -q --timeout=2 --spider "$HEALTH_URL" 2>/dev/null; then
      _open_browser "$FRONTEND_URL"
      exit 0
    fi
  fi
fi

# ── start BOOS backend ──────────────────────────────────────────────

# Find boos binary (same logic as install scripts).
BOOS_CMD=""
for candidate in \
  "$(npm config get prefix 2>/dev/null || echo /usr/local)/bin/boos" \
  /opt/homebrew/bin/boos \
  /usr/local/bin/boos \
  "$HOME/.local/bin/boos"
do
  if [ -x "$candidate" ]; then
    BOOS_CMD="$candidate"
    break
  fi
done

if [ -z "$BOOS_CMD" ]; then
  echo "[boos launcher] boos binary not found" >&2
  exit 1
fi

# Start detached (equivalent to Windows Shell.Run(..., 0, False)).
nohup "$BOOS_CMD" > /dev/null 2>&1 &
disown

# Give the server a moment to start, then open frontend.
sleep 1
_open_browser "$FRONTEND_URL"
