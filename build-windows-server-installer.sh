#!/usr/bin/env bash
# Builds SocketAgent-Server-Setup.exe on the Windows build host. No publishing;
# ./publish-desktop-installer.sh --server publishes it.
# --sign signs it, which counts as the day's signing run (see sign-windows.sh).
set -euo pipefail
SIGN=false
case "${1:-}" in
  --sign) SIGN=true ;;
  --allow-extra-signing) SIGN=true; export SOCKETAGENT_ALLOW_EXTRA_SIGNING=1 ;;
  "") ;;
  *) echo "Usage: $0 [--sign | --allow-extra-signing]" >&2; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(dirname "$ROOT")/socketagent-app}"
HOST="${SOCKETAGENT_WINDOWS_BUILD_HOST:-billy@10.10.10.69}"
REMOTE_DIR='C:/Users/billy/socketagent-server-installer'
OUT="$ROOT/build/windows"
# Same rule as the running server: major.minor from package.json, patch from the commit count.
BASE="$(node -p "require('$ROOT/server/package.json').version.split('.').slice(0, 2).join('.')")"
VERSION="$BASE.$(git -C "$ROOT" rev-list --count HEAD)"
# Fail before the build, not after it, when today's signing run is used up.
if $SIGN; then "$ROOT/sign-windows.sh" --check; fi
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '$REMOTE_DIR/input' | Out-Null\""
"$ROOT/stage-windows-setup-support.sh" "$HOST" "$REMOTE_DIR/input"
scp -q "$APP_DIR/windows/runner/resources/app_icon.ico" "$HOST:$REMOTE_DIR/input/app_icon.ico"
scp -q "$ROOT/windows-installer/socketagent-server.iss" "$ROOT/windows-installer/server-setup.ps1" "$ROOT/windows-installer/pairing-qr.js" "$HOST:$REMOTE_DIR/"
ssh "$HOST" "powershell -NoProfile -Command \"& (Join-Path \$env:LOCALAPPDATA 'Programs/Inno Setup 6/ISCC.exe') /Q '/DSupportDir=$REMOTE_DIR/input' '/DAppVersion=$VERSION' '$REMOTE_DIR/socketagent-server.iss'; exit \$LASTEXITCODE\""
mkdir -p "$OUT"
scp -q "$HOST:$REMOTE_DIR/packages/SocketAgent-Server-Setup.exe" "$OUT/"
if $SIGN; then "$ROOT/sign-windows.sh" "$OUT/SocketAgent-Server-Setup.exe"; fi
echo "Server installer $VERSION: $OUT/SocketAgent-Server-Setup.exe"
