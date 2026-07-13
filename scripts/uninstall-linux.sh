#!/bin/bash
# BOOS Linux uninstall script — reverse of install-linux.sh.
#
# Usage: bash uninstall-linux.sh [--force]
#   --force  Skip confirmation prompt.
#
# What this does:
#   1. Unregisters x-scheme-handler/boos from xdg-mime
#   2. Removes ~/.local/share/applications/boos.desktop
#   3. Removes ~/.local/share/boos/launcher.sh
#   4. Optionally removes the entire boos data dir
#
# Best-effort: failures are logged but don't block further steps.
# Requires: xdg-utils (xdg-mime)

set -euo pipefail

FORCE="${1:-}"
LOG_PREFIX="[boos uninstall linux]"

log()  { echo "$LOG_PREFIX $*"; }
warn() { echo "$LOG_PREFIX WARN: $*" >&2; }

# ── confirmation ──────────────────────────────────────────────────────

if [ "$FORCE" != "--force" ]; then
  echo ""
  echo "This will remove the boos:// protocol handler from Linux."
  echo "It will NOT remove the boos npm package or your session data."
  echo ""
  read -r -p "Continue? [y/N] " REPLY
  if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
    log "cancelled."
    exit 0
  fi
fi

# ── paths ─────────────────────────────────────────────────────────────

BOOS_DATA="$HOME/.local/share/boos"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$APPS_DIR/boos.desktop"
LAUNCHER="$BOOS_DATA/launcher.sh"

# ── 1. unregister MIME type ──────────────────────────────────────────

if command -v xdg-mime > /dev/null 2>&1; then
  # xdg-mime doesn't have a direct "unregister" — we remove the default
  # association and delete the .desktop file (step 2).  Querying the
  # default handler is the closest to "is it registered".
  CURRENT=$(xdg-mime query default x-scheme-handler/boos 2>/dev/null || true)
  if [ "$CURRENT" = "boos.desktop" ]; then
    # Remove the default association by setting it to an empty handler.
    # xdg-mime doesn't have a native "unset", but removing the .desktop
    # file (step 2) and running update-desktop-database is sufficient.
    log "MIME type currently registered — will be cleared by .desktop removal"
  else
    log "MIME type not registered (or different handler: ${CURRENT:-none})"
  fi
else
  warn "xdg-mime not found — skipping MIME unregister"
fi

# ── 2. remove desktop entry ──────────────────────────────────────────

if [ -f "$DESKTOP_FILE" ]; then
  rm -f "$DESKTOP_FILE"
  log "removed desktop entry: $DESKTOP_FILE"

  # Update desktop database so the removed entry is no longer cached.
  if command -v update-desktop-database > /dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" 2>/dev/null || true
    log "desktop database updated"
  fi
else
  log "desktop entry not found (already removed): $DESKTOP_FILE"
fi

# ── 3. remove launcher script ─────────────────────────────────────────

if [ -f "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
  log "removed launcher: $LAUNCHER"
else
  log "launcher not found (already removed): $LAUNCHER"
fi

# ── 4. remove boos data dir if empty ──────────────────────────────────

if [ -d "$BOOS_DATA" ]; then
  REMAINING=$(ls -A "$BOOS_DATA" 2>/dev/null || true)
  if [ -z "$REMAINING" ]; then
    rmdir "$BOOS_DATA" 2>/dev/null || true
    log "removed empty data dir: $BOOS_DATA"
  else
    log "data dir not empty — leaving: $BOOS_DATA"
  fi
fi

log "boos:// protocol unregistered on Linux"
log "done."
