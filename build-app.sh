#!/usr/bin/env bash
set -euo pipefail

# SocketAgent App Build Script
#
# Usage:
#   ./build-app.sh                     # Build APK on remote build machine
#   ./build-app.sh --deploy            # Build, bump patch, deploy to GitHub
#   ./build-app.sh --deploy --bump minor   # Build, bump minor, deploy

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$REPO_ROOT/app"
PUBSPEC="$APP_DIR/pubspec.yaml"
VERSION_FILE="$REPO_ROOT/app-version.json"
SERVER_REPO="Yllib/socketagent"
APK_PATH="$APP_DIR/build/app/outputs/flutter-apk/app-release.apk"
APP_ID_OVERRIDE="${SOCKETAGENT_APPLICATION_ID:-}"

FLUTTER_BIN="${FLUTTER_BIN:-/opt/flutter/bin}"
export PATH="$FLUTTER_BIN:/home/rdp/Android/Sdk/platform-tools:$PATH"

# ── Remote build config ──
REMOTE_HOST="billy@10.10.10.69"
REMOTE_DIR="C:/Users/billy/socketagent-app-build"
REMOTE_FLUTTER="C:/Users/billy/Downloads/flutter/flutter/bin/flutter.bat"
REMOTE_ANDROID_HOME="C:/Users/billy/AppData/Local/Android/Sdk"

BUMP="patch"
DEPLOY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --deploy) DEPLOY=true; shift ;;
    --local) echo "Local app builds are disabled. Use the remote build machine."; exit 1 ;;
    --bump) BUMP="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; echo "Usage: $0 [--deploy] [--bump major|minor|patch]"; exit 1 ;;
  esac
done

# ── Read current version ──
CURRENT=$(grep '^version:' "$PUBSPEC" | sed 's/version: //' | cut -d+ -f1)
BUILD=$(grep '^version:' "$PUBSPEC" | sed 's/version: //' | cut -d+ -f2)
ORIGINAL_VERSION_LINE=$(grep '^version:' "$PUBSPEC")
VERSION_BUMPED=false
APP_VERSION_COMMITTED=false

restore_version_on_failure() {
  local code=$?
  if $VERSION_BUMPED && ! $APP_VERSION_COMMITTED; then
    sed -i "s/^version: .*/$ORIGINAL_VERSION_LINE/" "$PUBSPEC"
    echo "Restored pubspec version after failed build/deploy."
  fi
  exit "$code"
}
trap restore_version_on_failure ERR

echo "Checking remote build machine ($REMOTE_HOST)..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" "echo ok" >/dev/null

if $DEPLOY; then
  # ── Bump version ──
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case $BUMP in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
    *) echo "Invalid bump: $BUMP (use major, minor, or patch)"; exit 1 ;;
  esac
  BUILD=$((BUILD + 1))
  NEW_VERSION="$MAJOR.$MINOR.$PATCH"
  echo "Bumping: $CURRENT → $NEW_VERSION+$BUILD"
  sed -i "s/^version: .*/version: $NEW_VERSION+$BUILD/" "$PUBSPEC"
  VERSION_BUMPED=true
else
  NEW_VERSION="$CURRENT"
  echo "Building v$CURRENT (no version bump)"
fi

# ── Build APK ──
echo "Building APK on remote ($REMOTE_HOST)..."
if [[ -n "$APP_ID_OVERRIDE" ]]; then
  echo "Using Android applicationId override: $APP_ID_OVERRIDE"
fi
BUILD_START=$SECONDS

# Sync app source to remote via tar (Windows SSH doesn't have rsync)
echo "  Syncing source..."
tar cf - -C "$APP_DIR" \
  --exclude='build' \
  --exclude='.dart_tool' \
  --exclude='.gradle' \
  --exclude='.idea' \
  --exclude='*.iml' \
  --exclude='.flutter-plugins-dependencies' \
  . | ssh "$REMOTE_HOST" "powershell -Command \"if (-not (Test-Path '$REMOTE_DIR')) { New-Item -ItemType Directory -Path '$REMOTE_DIR' -Force | Out-Null }; Set-Location '$REMOTE_DIR'; tar xf -\""

# Build on remote
echo "  Building on remote..."
REMOTE_APP_ID_ASSIGNMENT=""
if [[ -n "$APP_ID_OVERRIDE" ]]; then
  REMOTE_APP_ID_ASSIGNMENT="\$env:SOCKETAGENT_APPLICATION_ID='$APP_ID_OVERRIDE'; "
fi
ssh "$REMOTE_HOST" "powershell -Command \"${REMOTE_APP_ID_ASSIGNMENT}\$env:ANDROID_HOME='$REMOTE_ANDROID_HOME'; Set-Location '$REMOTE_DIR'; & '$REMOTE_FLUTTER' build apk --release 2>&1; \$code=\$LASTEXITCODE; if ((Test-Path 'build/app/outputs/flutter-apk/app-release.apk') -and \$code -ne 0) { Write-Output \\\"Flutter exited with code \$code after producing app-release.apk; continuing.\\\"; exit 0 }; exit \$code\"" | while read -r line; do
  echo "  [remote] $line"
done

# Copy APK back
echo "  Copying APK back..."
mkdir -p "$(dirname "$APK_PATH")"
scp "$REMOTE_HOST:$REMOTE_DIR/build/app/outputs/flutter-apk/app-release.apk" "$APK_PATH"

ELAPSED=$((SECONDS - BUILD_START))
echo "Remote build completed in ${ELAPSED}s"
echo "APK: $APK_PATH"

if ! $DEPLOY; then
  echo ""
  echo "=== Build complete ==="
  echo "APK: $APK_PATH"
  echo "Run with --deploy to bump version and publish to GitHub."
  exit 0
fi

# ── Commit app repo ──
cd "$APP_DIR"
git add -A
git commit -m "Release v$NEW_VERSION" || true
APP_VERSION_COMMITTED=true
git push

# ── Update app-version.json and push ──
cd "$REPO_ROOT"
cat > "$VERSION_FILE" << EOF
{
  "version": "$NEW_VERSION",
  "url": "https://github.com/$SERVER_REPO/releases/download/v$NEW_VERSION/app-release.apk"
}
EOF

git add "$VERSION_FILE"
git commit -m "Release app v$NEW_VERSION" || true
git push

# ── Create GitHub release with APK ──
echo "Creating GitHub release v$NEW_VERSION..."
gh release create "v$NEW_VERSION" "$APK_PATH" \
  --repo "$SERVER_REPO" \
  --title "SocketAgent v$NEW_VERSION" \
  --notes "App version $NEW_VERSION" \
  --latest

echo ""
echo "=== Deploy complete ==="
echo "Version: $NEW_VERSION"
echo "Release: https://github.com/$SERVER_REPO/releases/tag/v$NEW_VERSION"
echo "Users will see the update banner on next app launch."
