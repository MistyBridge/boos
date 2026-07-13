#!/bin/bash
# BOOS macOS install script — run once to register the boos:// URL protocol.
#
# Usage: bash install-darwin.sh [boos-binary-path]
#   If no path given, auto-detects global npm bin/boos.
#
# What this does:
#   1. Creates ~/Library/Application Support/boos/launcher.sh
#   2. Creates a minimal helper .app bundle with Info.plist (CFBundleURLTypes)
#   3. Registers the helper app with Launch Services (lsregister)
#   4. Opens the setup guide in the default browser
#
# Best-effort: failures are logged but don't block further steps.

set -euo pipefail

BOOS_CMD="${1:-}"
LOG_PREFIX="[boos install darwin]"

log()  { echo "$LOG_PREFIX $*"; }
warn() { echo "$LOG_PREFIX WARN: $*" >&2; }

# ── find boos binary ─────────────────────────────────────────────────

if [ -z "$BOOS_CMD" ]; then
  # Try global npm bin first.
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"
  BOOS_CMD="$NPM_PREFIX/bin/boos"
  if [ ! -x "$BOOS_CMD" ]; then
    # Fallback: check common locations.
    if [ -x /opt/homebrew/bin/boos ]; then
      BOOS_CMD=/opt/homebrew/bin/boos
    elif [ -x /usr/local/bin/boos ]; then
      BOOS_CMD=/usr/local/bin/boos
    else
      warn "boos binary not found. Specify path: bash install-darwin.sh /path/to/boos"
      exit 1
    fi
  fi
fi

log "using boos binary: $BOOS_CMD"

# ── app bundle dirs ──────────────────────────────────────────────────

BOOS_HOME="$HOME/Library/Application Support/boos"
APP_DIR="$BOOS_HOME/boos-helper.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# ── 1. launcher script ──────────────────────────────────────────────

LAUNCHER="$BOOS_HOME/launcher.sh"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/bin/bash
# BOOS launcher — triggered by boos:// URL protocol on macOS.
# Decodes the URL, checks if BOOS is already running, starts or focuses.
URL="\$1"
BOOS_CMD="$BOOS_CMD"

# Check if BOOS is already running (listening on default port).
if curl -sf http://127.0.0.1:7777/api/health > /dev/null 2>&1; then
  # Already running — open frontend.
  open "https://MistyBridge.github.io/boos/"
else
  # Start BOOS backend in background.
  nohup "\$BOOS_CMD" > /dev/null 2>&1 &
  disown
fi
LAUNCHER_EOF
chmod +x "$LAUNCHER"
log "launcher written: $LAUNCHER"

# ── 2. helper app bundle ────────────────────────────────────────────

# Minimal executable that delegates to launcher.sh.
cat > "$MACOS_DIR/boos-helper" << HELPER_EOF
#!/bin/bash
exec "$LAUNCHER" "\$@"
HELPER_EOF
chmod +x "$MACOS_DIR/boos-helper"
log "helper binary: $MACOS_DIR/boos-helper"

# ── 3. Info.plist ───────────────────────────────────────────────────

cat > "$CONTENTS_DIR/Info.plist" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>BOOS Helper</string>
  <key>CFBundleIdentifier</key>
  <string>com.mistybridge.boos.helper</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleExecutable</key>
  <string>boos-helper</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>BOOS Protocol</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>boos</string>
      </array>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
    </dict>
  </array>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST_EOF
log "Info.plist written: $CONTENTS_DIR/Info.plist"

# ── 4. register with Launch Services ────────────────────────────────

LSREGISTER=""
for candidate in \
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" \
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
do
  if [ -x "$candidate" ]; then LSREGISTER="$candidate"; break; fi
done

if [ -n "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP_DIR" > /dev/null 2>&1 || true
  log "registered with Launch Services: $APP_DIR"
else
  # Fallback: open the helper app once to trigger registration.
  open "$APP_DIR" 2>/dev/null || true
  log "registered via open (lsregister not found)"
fi

log "boos:// protocol registered on macOS"

# ── 5. open setup guide ─────────────────────────────────────────────

if [ "${BOOS_NO_AUTOLAUNCH:-}" != "1" ]; then
  open "https://MistyBridge.github.io/boos/setup/" 2>/dev/null || true
  log "opened setup guide"
  log "(set BOOS_NO_AUTOLAUNCH=1 to skip this on future installs)"
fi

log "done — try clicking a boos://start link"
