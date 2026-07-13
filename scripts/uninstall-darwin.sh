#!/bin/bash
# BOOS macOS uninstall script — reverse of install-darwin.sh.
#
# Usage: bash uninstall-darwin.sh [--force]
#   --force  Skip confirmation prompt.
#
# What this does:
#   1. Unregisters the helper .app from Launch Services
#   2. Removes ~/Library/Application Support/boos/boos-helper.app
#   3. Removes ~/Library/Application Support/boos/launcher.sh
#   4. Optionally removes the entire boos data dir
#
# Best-effort: failures are logged but don't block further steps.

set -euo pipefail

FORCE="${1:-}"
LOG_PREFIX="[boos uninstall darwin]"

log()  { echo "$LOG_PREFIX $*"; }
warn() { echo "$LOG_PREFIX WARN: $*" >&2; }

# ── confirmation ──────────────────────────────────────────────────────

if [ "$FORCE" != "--force" ]; then
  echo ""
  echo "This will remove the boos:// protocol handler from macOS."
  echo "It will NOT remove the boos npm package or your session data."
  echo ""
  read -r -p "Continue? [y/N] " REPLY
  if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
    log "cancelled."
    exit 0
  fi
fi

# ── paths ─────────────────────────────────────────────────────────────

BOOS_HOME="$HOME/Library/Application Support/boos"
APP_DIR="$BOOS_HOME/boos-helper.app"
LAUNCHER="$BOOS_HOME/launcher.sh"

# ── 1. unregister from Launch Services ────────────────────────────────

LSREGISTER=""
for candidate in \
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" \
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
do
  if [ -x "$candidate" ]; then LSREGISTER="$candidate"; break; fi
done

if [ -n "$LSREGISTER" ] && [ -d "$APP_DIR" ]; then
  "$LSREGISTER" -u "$APP_DIR" > /dev/null 2>&1 || true
  log "unregistered from Launch Services: $APP_DIR"
elif [ -d "$APP_DIR" ]; then
  warn "lsregister not found — skipping Launch Services unregister"
fi

# ── 2. remove helper .app bundle ─────────────────────────────────────

if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR"
  log "removed helper app: $APP_DIR"
else
  log "helper app not found (already removed): $APP_DIR"
fi

# ── 3. remove launcher script ─────────────────────────────────────────

if [ -f "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
  log "removed launcher: $LAUNCHER"
else
  log "launcher not found (already removed): $LAUNCHER"
fi

# ── 4. remove boos data dir if empty ──────────────────────────────────

if [ -d "$BOOS_HOME" ]; then
  # Only remove if empty (or only contains files we created).
  REMAINING=$(ls -A "$BOOS_HOME" 2>/dev/null || true)
  if [ -z "$REMAINING" ]; then
    rmdir "$BOOS_HOME" 2>/dev/null || true
    log "removed empty data dir: $BOOS_HOME"
  else
    log "data dir not empty — leaving: $BOOS_HOME"
  fi
fi

log "boos:// protocol unregistered on macOS"
log "done."
