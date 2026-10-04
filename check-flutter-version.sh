#!/usr/bin/env bash
set -euo pipefail

# Refuses to continue when the remote build machine's Flutter differs from the
# one here, where the app's tests run. Used by build-app.sh and
# build-windows-app.sh before every remote build.
#
# Usage: ./check-flutter-version.sh <ssh host> <remote flutter.bat path>

HOST="$1"
REMOTE_FLUTTER="$2"
LOCAL_FLUTTER="$(command -v flutter || echo "$HOME/flutter/bin/flutter")"

framework_version() {
  grep -o '"frameworkVersion": *"[^"]*"' | grep -o '[0-9][^"]*' || true
}

local_version="$("$LOCAL_FLUTTER" --version --machine 2>/dev/null | framework_version)"
remote_version="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$REMOTE_FLUTTER --version --machine" 2>/dev/null | tr -d '\r' | framework_version)"

if [[ -z "$local_version" || -z "$remote_version" ]]; then
  echo "Could not read Flutter versions (here: '${local_version:-?}', $HOST: '${remote_version:-?}')." >&2
  exit 1
fi
if [[ "$local_version" != "$remote_version" ]]; then
  echo "Flutter differs: $local_version here, $remote_version on $HOST." >&2
  echo "Run 'flutter upgrade' on both so builds use the Flutter the tests ran on." >&2
  exit 1
fi
echo "Flutter $local_version on both machines"
