#!/usr/bin/env bash
# Builds SocketAgent-Desktop-Setup.exe on the Windows build host.
#
# The installer carries setup only. At install time it downloads
# SocketAgent-windows-x64.zip from the newest GitHub release that has one, so
# every app deploy reuses the same signed installer. Rebuild and sign it only
# when one of INPUTS below changes; build-app.sh --deploy refuses to ship a
# desktop release until the recorded installer matches them.
#
# Usage:
#   ./build-windows-desktop-installer.sh                        # unsigned test build
#   ./build-windows-desktop-installer.sh --sign                 # sign, publish and record it
#   ./build-windows-desktop-installer.sh --allow-extra-signing  # same, as a second signing run today
#   ./build-windows-desktop-installer.sh --check <file>         # for deploy: verify the record and
#                                                                # fetch the published installer to <file>
#
# --sign counts as the day's signing run (see sign-windows.sh). It writes
# windows-installer/desktop-installer.json, which must be committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(dirname "$ROOT")/socketagent-app}"
HOST="${SOCKETAGENT_WINDOWS_BUILD_HOST:-billy@10.10.10.69}"
REMOTE_DIR='C:/Users/billy/socketagent-desktop-installer'
OUT="$APP_DIR/build/windows/packages"
RECORD="$ROOT/windows-installer/desktop-installer.json"
DOWNLOAD_HOST="${SOCKETAGENT_DOWNLOAD_HOST:-deploy@5.78.209.159}"
DOWNLOAD_KEY="${SOCKETAGENT_DOWNLOAD_KEY:-$HOME/.ssh/hetzner_prod_ed25519}"
DOWNLOAD_DIR="${SOCKETAGENT_DOWNLOAD_DIR:-/home/deploy/apps/sector-downloads/public}"

# Everything compiled into the installer, relative to the app checkout, plus
# the server bootstrap it runs for "Install the local server".
INPUTS=(scripts/installer/socketagent.iss scripts/installer/desktop-setup.ps1 scripts/installer/server-discovery.ps1 scripts/build-windows-installer.ps1 windows/runner/resources/app_icon.ico)
inputs_hash() {
  (cd "$APP_DIR" && cat "${INPUTS[@]}" && cat "$ROOT/install-windows.ps1") | sha256sum | cut -d' ' -f1
}
record_field() { node -p "require('$RECORD').$1"; }

SIGN=false
case "${1:-}" in
  --sign) SIGN=true ;;
  --allow-extra-signing) SIGN=true; export SOCKETAGENT_ALLOW_EXTRA_SIGNING=1 ;;
  --check)
    TARGET="${2:?Usage: $0 --check <file>}"
    if [[ ! -f "$RECORD" ]]; then
      echo "No signed desktop installer is recorded. Run $0 --sign first." >&2
      exit 1
    fi
    if [[ "$(record_field inputs)" != "$(inputs_hash)" ]]; then
      echo "Desktop installer setup changed since the signed installer was built." >&2
      echo "Run $0 --sign (the day's signing run), commit $RECORD, then deploy." >&2
      exit 1
    fi
    VERSION="$(record_field version)"
    mkdir -p "$(dirname "$TARGET")"
    # The versioned file, not the stable URL, which Cloudflare may serve stale.
    scp -q -o BatchMode=yes -i "$DOWNLOAD_KEY" "$DOWNLOAD_HOST:$DOWNLOAD_DIR/releases/socketagent-desktop-$VERSION.exe" "$TARGET"
    if [[ "$(sha256sum "$TARGET" | cut -d' ' -f1)" != "$(record_field sha256)" ]]; then
      echo "The published desktop installer $VERSION does not match $RECORD." >&2
      exit 1
    fi
    echo "Desktop installer $VERSION verified: $TARGET"
    exit 0 ;;
  "") ;;
  *) echo "Usage: $0 [--sign | --allow-extra-signing | --check <file>]" >&2; exit 1 ;;
esac

VERSION="$(grep '^version:' "$APP_DIR/pubspec.yaml" | sed 's/version: //' | cut -d+ -f1)"
# Fail before the build, not after it, when today's signing run is used up.
if $SIGN; then "$ROOT/sign-windows.sh" --check; fi
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "powershell -NoProfile -Command \"if (Test-Path '$REMOTE_DIR') { Remove-Item -LiteralPath '$REMOTE_DIR' -Recurse -Force }; New-Item -ItemType Directory -Force '$REMOTE_DIR/build/installer-input' | Out-Null\""
tar cf - -C "$APP_DIR" "${INPUTS[@]}" scripts/installer/test-server-discovery.ps1 | ssh "$HOST" "tar xf - -C $REMOTE_DIR"
scp -q "$ROOT/install-windows.ps1" "$HOST:$REMOTE_DIR/build/installer-input/server-bootstrap.ps1"
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_DIR/scripts/build-windows-installer.ps1 -Version $VERSION"
mkdir -p "$OUT"
scp -q "$HOST:$REMOTE_DIR/build/windows/packages/SocketAgent-Desktop-Setup.exe" "$OUT/"
if $SIGN; then
  "$ROOT/sign-windows.sh" "$OUT/SocketAgent-Desktop-Setup.exe"
  "$ROOT/publish-desktop-installer.sh" --installer "$OUT/SocketAgent-Desktop-Setup.exe" --version "$VERSION"
  cat > "$RECORD" <<EOF
{
  "version": "$VERSION",
  "sha256": "$(sha256sum "$OUT/SocketAgent-Desktop-Setup.exe" | cut -d' ' -f1)",
  "inputs": "$(inputs_hash)"
}
EOF
  echo "Recorded in $RECORD. Commit it before the next deploy."
fi
echo "Desktop installer $VERSION: $OUT/SocketAgent-Desktop-Setup.exe"
