#!/usr/bin/env bash
set -euo pipefail

# Publishes the Windows desktop installer to the public download URL.
#
# The phone's file-transfer download does not work on the desktop client, so
# desktop updates are fetched from a stable URL instead. Run it standalone to
# republish or roll back without redoing an app release; build-app.sh --deploy
# calls it as its last step.
#
# Usage:
#   ./publish-desktop-installer.sh                          # publish the built installer
#   ./publish-desktop-installer.sh --installer <path>       # publish a specific file
#   ./publish-desktop-installer.sh --version 1.0.253        # repoint to a retained release
#
# --version alone, with no matching local file, repoints the stable URL at a
# release already on the host, which is the rollback path.

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(cd "$REPO_ROOT/.." && pwd)/socketagent-app}"
INSTALLER="$APP_DIR/build/windows/packages/SocketAgent-Desktop-Setup.exe"
VERSION=""

DOWNLOAD_HOST="${SOCKETAGENT_DOWNLOAD_HOST:-deploy@5.78.209.159}"
DOWNLOAD_KEY="${SOCKETAGENT_DOWNLOAD_KEY:-$HOME/.ssh/hetzner_prod_ed25519}"
DOWNLOAD_DIR="${SOCKETAGENT_DOWNLOAD_DIR:-/home/deploy/apps/sector-downloads/public}"
PUBLIC_URL="${SOCKETAGENT_DOWNLOAD_URL:-https://rubanoenterprises.com/socketagent_desktop_installer.exe}"
STABLE_NAME="socketagent_desktop_installer.exe"

while [[ $# -gt 0 ]]; do
  case $1 in
    --installer) INSTALLER="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; echo "Usage: $0 [--installer <path>] [--version <x.y.z>]"; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION=$(grep '^version:' "$APP_DIR/pubspec.yaml" | sed 's/version: //' | cut -d+ -f1)
fi

RELEASE_NAME="socketagent-desktop-$VERSION.exe"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$DOWNLOAD_KEY")

echo "Publishing desktop installer v$VERSION..."

if [[ -f "$INSTALLER" ]]; then
  LOCAL_HASH=$(sha256sum "$INSTALLER" | cut -d' ' -f1)
  echo "  local: $LOCAL_HASH ($(stat -c%s "$INSTALLER") bytes)"

  # --append-verify resumes a partial upload instead of re-sending 20 MB.
  rsync -e "${SSH[*]}" --partial --append-verify \
    "$INSTALLER" "$DOWNLOAD_HOST:$DOWNLOAD_DIR/releases/$RELEASE_NAME.part"

  REMOTE_HASH=$("${SSH[@]}" "$DOWNLOAD_HOST" "sha256sum '$DOWNLOAD_DIR/releases/$RELEASE_NAME.part'" | cut -d' ' -f1)
  if [[ "$REMOTE_HASH" != "$LOCAL_HASH" ]]; then
    echo "Upload hash mismatch; leaving the .part file and the live URL untouched." >&2
    echo "  remote: $REMOTE_HASH" >&2
    exit 1
  fi

  # Promoted only once the bytes are known good, so the stable name can never
  # point at a truncated upload.
  "${SSH[@]}" "$DOWNLOAD_HOST" "
    set -e
    cd '$DOWNLOAD_DIR/releases'
    mv -f '$RELEASE_NAME.part' '$RELEASE_NAME'
    chmod 0644 '$RELEASE_NAME'
  "
else
  echo "  no local installer; repointing to the retained $RELEASE_NAME"
  "${SSH[@]}" "$DOWNLOAD_HOST" "test -f '$DOWNLOAD_DIR/releases/$RELEASE_NAME'"
  LOCAL_HASH=$("${SSH[@]}" "$DOWNLOAD_HOST" "sha256sum '$DOWNLOAD_DIR/releases/$RELEASE_NAME'" | cut -d' ' -f1)
fi

# Swapping a symlink over itself is atomic, so a download in flight never sees
# a missing file and no container restart is needed.
"${SSH[@]}" "$DOWNLOAD_HOST" "
  set -e
  cd '$DOWNLOAD_DIR'
  ln -sfn 'releases/$RELEASE_NAME' '.$STABLE_NAME.next'
  mv -Tf '.$STABLE_NAME.next' '$STABLE_NAME'
"

echo "Verifying $PUBLIC_URL..."
PUBLIC_HASH=$(curl -fsS --max-time 600 "$PUBLIC_URL" | sha256sum | cut -d' ' -f1)
if [[ "$PUBLIC_HASH" != "$LOCAL_HASH" ]]; then
  echo "Public download does not match the published file." >&2
  echo "  expected: $LOCAL_HASH" >&2
  echo "  served:   $PUBLIC_HASH" >&2
  exit 1
fi

echo "Desktop installer published: $PUBLIC_URL"
echo "  version: $VERSION"
echo "  sha256:  $PUBLIC_HASH"
