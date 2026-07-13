#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "SocketAgent Server.app is only used on macOS." >&2
  exit 1
fi

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/.." && pwd)"
APP_DIR="${SOCKETAGENT_MACOS_HELPER_APP:-$HOME/Applications/SocketAgent Server.app}"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
EXECUTABLE="$MACOS_DIR/socketagent-server"
SOURCE="$SERVER_DIR/macos-helper/main.c"
SOURCE_VERSION="1"
VERSION_FILE="$RESOURCES_DIR/helper-version"
SERVICE_LABEL="com.socketagent.server"
SERVICE_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

install_icon() {
  local source="$REPO_ROOT/icons/icon3_abstract_s.png"
  [[ -f "$source" ]] || return 0
  local iconset="$RESOURCES_DIR/SocketAgent.iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    local double=$((size * 2))
    sips -z "$double" "$double" "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$RESOURCES_DIR/SocketAgent.icns"
  rm -rf "$iconset"
}

install_helper() {
  if [[ -x "$EXECUTABLE" && -f "$VERSION_FILE" && "$(cat "$VERSION_FILE")" == "$SOURCE_VERSION" ]]; then
    return 0
  fi
  command -v cc >/dev/null 2>&1 || {
    echo "The macOS C compiler is required to install SocketAgent Server.app." >&2
    exit 1
  }
  mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
  cc -Os -Wall -Wextra "$SOURCE" -o "$EXECUTABLE"
  chmod 755 "$EXECUTABLE"
  printf '%s\n' "$SOURCE_VERSION" > "$VERSION_FILE"

  cat > "$CONTENTS_DIR/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>SocketAgent Server</string>
  <key>CFBundleExecutable</key>
  <string>socketagent-server</string>
  <key>CFBundleIconFile</key>
  <string>SocketAgent</string>
  <key>CFBundleIdentifier</key>
  <string>com.socketagent.server.helper</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>SocketAgent Server</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>NSDesktopFolderUsageDescription</key>
  <string>SocketAgent needs access so you can browse and work with files from your phone.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>SocketAgent needs access so you can browse and work with files from your phone.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>SocketAgent needs access so you can transfer files to and from your phone.</string>
</dict>
</plist>
EOF
  plutil -lint "$CONTENTS_DIR/Info.plist" >/dev/null
  install_icon
  codesign --force --deep --sign - --identifier com.socketagent.server.helper "$APP_DIR" >/dev/null
  echo "Installed $APP_DIR"
}

configure_service() {
  [[ -f "$SERVICE_PLIST" ]] || return 0
  local current
  current="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SERVICE_PLIST" 2>/dev/null || true)"
  if [[ "$current" == "$EXECUTABLE" ]]; then
    return 0
  fi

  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $EXECUTABLE" "$SERVICE_PLIST"
  if ! /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:SOCKETAGENT_START_SCRIPT' "$SERVICE_PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:SOCKETAGENT_START_SCRIPT string' "$SERVICE_PLIST"
  fi
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:SOCKETAGENT_START_SCRIPT $SERVER_DIR/scripts/start-server.sh" "$SERVICE_PLIST"
  plutil -lint "$SERVICE_PLIST" >/dev/null
  echo "SERVICE_CHANGED"

  if launchctl print "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1; then
    local reload_label="com.socketagent.helper-migration.$$"
    local command="sleep 2; launchctl bootout '$GUI_DOMAIN/$SERVICE_LABEL' >/dev/null 2>&1 || true; launchctl bootstrap '$GUI_DOMAIN' '$SERVICE_PLIST'"
    launchctl submit -l "$reload_label" -- /bin/bash -c "$command"
    echo "Scheduled launchd migration to SocketAgent Server.app"
  fi
}

install_helper
case "${1:-}" in
  --configure-service) configure_service ;;
  --print-path) printf '%s\n' "$APP_DIR" ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
