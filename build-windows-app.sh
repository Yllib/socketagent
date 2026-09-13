#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(dirname "$ROOT")/socketagent-app}"
HOST="${SOCKETAGENT_WINDOWS_BUILD_HOST:-billy@10.10.10.69}"
REMOTE_DIR='C:/Users/billy/socketagent-windows-build'
if [[ $# -gt 0 ]]; then
  echo 'Usage: ./build-app.sh --windows (local test package; no publishing)' >&2
  exit 1
fi
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '$REMOTE_DIR' | Out-Null\""
tar cf - -C "$APP_DIR" --exclude='.git' --exclude='build' --exclude='.dart_tool' --exclude='.flutter-plugins-dependencies' --exclude='windows/flutter/ephemeral' --exclude='android' --exclude='play-store' . |
  ssh "$HOST" "tar xf - -C $REMOTE_DIR"
# Bundle only reviewed installer support, never server configuration or private data.
ssh "$HOST" "powershell -NoProfile -Command \"if (Test-Path '$REMOTE_DIR/build/installer-input/server-support') { Remove-Item -LiteralPath '$REMOTE_DIR/build/installer-input/server-support' -Recurse -Force }; New-Item -ItemType Directory -Force '$REMOTE_DIR/build/installer-input/server-support' | Out-Null\""
tar cf - -C "$ROOT" install.ps1 bin/socketagent.ps1 server/scripts/windows-service.ps1 server/scripts/windows-launcher.cs server/scripts/register-windows-recovery.ps1 server/scripts/migrate-windows-service.ps1 server/scripts/check-health.js server/src/windows-managed-shims.ts |
  ssh "$HOST" "tar xf - -C $REMOTE_DIR/build/installer-input/server-support"
scp "$ROOT/install-windows.ps1" "$HOST:$REMOTE_DIR/build/installer-input/server-bootstrap.ps1"
ssh "$HOST" "powershell -NoProfile -Command \"Compress-Archive -Path '$REMOTE_DIR/build/installer-input/server-support/*' -DestinationPath '$REMOTE_DIR/build/installer-input/server-support.zip' -Force\""
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_DIR/scripts/build-windows.ps1"
mkdir -p "$APP_DIR/build/windows/packages"
scp "$HOST:$REMOTE_DIR/build/windows/packages/SocketAgent-windows-x64.zip" "$APP_DIR/build/windows/packages/"
scp "$HOST:$REMOTE_DIR/build/windows/packages/SocketAgent-Desktop-Setup.exe" "$APP_DIR/build/windows/packages/"
echo "Windows installer: $APP_DIR/build/windows/packages/SocketAgent-Desktop-Setup.exe"
echo "Windows test package: $APP_DIR/build/windows/packages/SocketAgent-windows-x64.zip"
