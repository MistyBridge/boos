#!/bin/bash
# BOOS Linux install script — run once to register the boos:// URL protocol.
#
# Usage: bash install-linux.sh [boos-binary-path]
#   If no path given, auto-detects global npm bin/boos.
#
# What this does:
#   1. Creates ~/.local/share/boos/launcher.sh
#   2. Writes ~/.local/share/applications/boos.desktop
#   3. Registers x-scheme-handler/boos via xdg-mime
#   4. Opens the setup guide via xdg-open
#
# Best-effort: failures are logged but don't block further steps.
# Requires: xdg-utils (xdg-mime, xdg-open), desktop-file-utils (update-desktop-database)

set -euo pipefail

BOOS_CMD="${1:-}"
LOG_PREFIX="[boos install linux]"

log()  { echo "$LOG_PREFIX $*"; }
warn() { echo "$LOG_PREFIX WARN: $*" >&2; }

# ── find boos binary ─────────────────────────────────────────────────

if [ -z "$BOOS_CMD" ]; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"
  BOOS_CMD="$NPM_PREFIX/bin/boos"
  if [ ! -x "$BOOS_CMD" ]; then
    if [ -x /usr/local/bin/boos ]; then
      BOOS_CMD=/usr/local/bin/boos
    elif [ -x "$HOME/.local/bin/boos" ]; then
      BOOS_CMD="$HOME/.local/bin/boos"
    else
      warn "boos binary not found. Specify path: bash install-linux.sh /path/to/boos"
      exit 1
    fi
  fi
fi

log "using boos binary: $BOOS_CMD"

# ── directories ──────────────────────────────────────────────────────

BOOS_DATA="$HOME/.local/share/boos"
APPS_DIR="$HOME/.local/share/applications"

mkdir -p "$BOOS_DATA" "$APPS_DIR"

# ── 1. launcher script ──────────────────────────────────────────────

LAUNCHER="$BOOS_DATA/launcher.sh"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/bin/bash
# BOOS launcher — triggered by boos:// URL protocol on Linux.
URL="\$1"
BOOS_CMD="$BOOS_CMD"

if curl -sf http://127.0.0.1:7777/api/health > /dev/null 2>&1; then
  xdg-open "https://MistyBridge.github.io/boos/" > /dev/null 2>&1 &
else
  nohup "\$BOOS_CMD" > /dev/null 2>&1 &
  disown
fi
LAUNCHER_EOF
chmod +x "$LAUNCHER"
log "launcher written: $LAUNCHER"

# ── 2. desktop entry ────────────────────────────────────────────────

DESKTOP_FILE="$APPS_DIR/boos.desktop"
cat > "$DESKTOP_FILE" << DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=BOOS
Comment=BOOS Session Manager — protocol handler
Exec=$LAUNCHER %u
Terminal=false
Categories=Utility;
MimeType=x-scheme-handler/boos;
NoDisplay=true
StartupNotify=false
DESKTOP_EOF
log "desktop entry written: $DESKTOP_FILE"

# ── 3. register MIME type ───────────────────────────────────────────

if command -v xdg-mime > /dev/null 2>&1; then
  xdg-mime default boos.desktop x-scheme-handler/boos
  log "MIME type registered via xdg-mime"
else
  warn "xdg-mime not found — install xdg-utils"
fi

if command -v update-desktop-database > /dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
  log "desktop database updated"
fi

log "boos:// protocol registered on Linux"

# ── 4. open setup guide ─────────────────────────────────────────────

if [ "${BOOS_NO_AUTOLAUNCH:-}" != "1" ]; then
  if command -v xdg-open > /dev/null 2>&1; then
    xdg-open "https://MistyBridge.github.io/boos/setup/" > /dev/null 2>&1 &
    log "opened setup guide"
  fi
fi

log "done — try clicking a boos://start link"
