#!/usr/bin/env bash
# Copies the reviewed Windows setup files into <remote dir> on the build host:
# server-bootstrap.ps1 and server-support.zip, which install-windows.ps1 lays
# over the clone so setup matches this checkout. Never copies server
# configuration or private data. Used by the desktop installer, so its server
# setup matches the app version it ships with.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST="$1"
DIR="$2"
ssh "$HOST" "powershell -NoProfile -Command \"if (Test-Path '$DIR/server-support') { Remove-Item -LiteralPath '$DIR/server-support' -Recurse -Force }; New-Item -ItemType Directory -Force '$DIR/server-support' | Out-Null\""
tar cf - -C "$ROOT" install.ps1 bin/socketagent.ps1 server/scripts/windows-service.ps1 server/scripts/windows-launcher.cs server/scripts/register-windows-recovery.ps1 server/scripts/migrate-windows-service.ps1 server/scripts/check-health.js server/src/windows-managed-shims.ts |
  ssh "$HOST" "tar xf - -C $DIR/server-support"
scp -q "$ROOT/install-windows.ps1" "$HOST:$DIR/server-bootstrap.ps1"
ssh "$HOST" "powershell -NoProfile -Command \"Compress-Archive -Path '$DIR/server-support/*' -DestinationPath '$DIR/server-support.zip' -Force\""
