#!/usr/bin/env bash
#
# Moves the pinned agent dependencies to their latest published versions,
# proves the result still builds and passes the suite, and commits the bump.
#
# The lockfile is what every machine installs from, so a version only reaches
# them by being committed here. This script is what the pre-push hook expects
# you to have run.
#
#   update-agent-sdk.sh              bump, verify, commit
#   update-agent-sdk.sh --no-commit  bump and verify, leave it in the tree
#   update-agent-sdk.sh --check      report only, change nothing
#
set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$SERVER_DIR/.." && pwd)"
PACKAGES=(@anthropic-ai/claude-agent-sdk @anthropic-ai/sdk)

MODE=commit
case "${1:-}" in
  --no-commit) MODE=no-commit ;;
  --check)     MODE=check ;;
  "")          ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

cd "$SERVER_DIR" || exit 1

installed() { node -p "require('./node_modules/$1/package.json').version" 2>/dev/null; }
latest()    { npm view "$1" version 2>/dev/null; }

stale=()
for pkg in "${PACKAGES[@]}"; do
  have="$(installed "$pkg")"; want="$(latest "$pkg")"
  if [ -z "$want" ]; then
    echo "  ? $pkg  could not reach the npm registry" >&2
    exit 3
  fi
  if [ "$have" = "$want" ]; then
    echo "  = $pkg  $have"
  else
    echo "  ^ $pkg  $have -> $want"
    stale+=("$pkg@$want")
  fi
done

if [ ${#stale[@]} -eq 0 ]; then
  echo "Already on the latest agent dependencies."
  exit 0
fi
[ "$MODE" = check ] && exit 1

# Restore the pins and node_modules if the new versions do not hold up.
rollback() {
  echo "Rolling back to the committed versions." >&2
  git -C "$REPO_DIR" checkout -- server/package.json server/package-lock.json
  npm ci --include=optional >/dev/null 2>&1
}

echo "Installing: ${stale[*]}"
if ! npm install "${stale[@]}"; then
  rollback; echo "FAILED: npm install" >&2; exit 1
fi

echo "Building..."
if ! npm run build; then
  rollback; echo "FAILED: the new versions do not typecheck" >&2; exit 1
fi

echo "Testing..."
if ! npm test; then
  rollback; echo "FAILED: the suite does not pass on the new versions" >&2; exit 1
fi

if [ "$MODE" = no-commit ]; then
  echo "Verified. Left uncommitted as requested."
  exit 0
fi

git -C "$REPO_DIR" add server/package.json server/package-lock.json
git -C "$REPO_DIR" commit -m "Update agent dependencies to latest

$(printf '  %s\n' "${stale[@]}")

Typecheck and the full suite pass on these versions."
echo "Committed."
