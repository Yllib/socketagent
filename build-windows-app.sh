#!/usr/bin/env bash
# Builds the Windows desktop app into SocketAgent-windows-x64.zip on the build
# host. The installer is separate (build-windows-desktop-installer.sh) and
# downloads this zip from the GitHub release, so app builds never sign.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(dirname "$ROOT")/socketagent-app}"
HOST="${SOCKETAGENT_WINDOWS_BUILD_HOST:-billy@10.10.10.69}"
REMOTE_DIR='C:/Users/billy/socketagent-windows-build'
if [[ $# -gt 0 ]]; then
  echo 'Usage: ./build-app.sh --windows (local test package; no publishing)' >&2
  exit 1
fi
"$ROOT/check-flutter-version.sh" "$HOST" 'C:/Users/billy/Downloads/flutter/flutter/bin/flutter.bat'
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '$REMOTE_DIR' | Out-Null\""
tar cf - -C "$APP_DIR" --exclude='.git' --exclude='build' --exclude='.dart_tool' --exclude='.flutter-plugins-dependencies' --exclude='windows/flutter/ephemeral' --exclude='android' --exclude='play-store' . |
  ssh "$HOST" "tar xf - -C $REMOTE_DIR"
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_DIR/scripts/build-windows.ps1"
mkdir -p "$APP_DIR/build/windows/packages"
scp "$HOST:$REMOTE_DIR/build/windows/packages/SocketAgent-windows-x64.zip" "$APP_DIR/build/windows/packages/"
echo "Windows app package: $APP_DIR/build/windows/packages/SocketAgent-windows-x64.zip"
echo "Install it with SocketAgent-Desktop-Setup.exe /PACKAGE=<zip>, or run install-windows-app.cmd from the unpacked zip."
