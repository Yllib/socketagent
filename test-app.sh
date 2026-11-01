#!/usr/bin/env bash
# Runs the Flutter app's tests on the Windows build machine's WSL Ubuntu,
# which has 20 threads to this server's 4. The full suite takes about a
# minute there and five here.
#
# Usage:
#   ./test-app.sh                          # full suite
#   ./test-app.sh test/tasks_editor_test.dart [more files or flutter test flags]
#
# One-time setup on the build machine: copy this server's Flutter SDK into
# WSL at /root/flutter (same version as builds, checked below), e.g.
#   tar cf - -C ~ flutter | ssh billy@10.10.10.69 wsl.exe -d Ubuntu -- tar xf - -C /root
# Tests read fonts from $HOME/flutter, which is /root/flutter for WSL's root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(dirname "$ROOT")/socketagent-app}"
HOST="${SOCKETAGENT_TEST_HOST:-billy@10.10.10.69}"
WSL=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" wsl.exe -d Ubuntu)

# wsl.exe hands its arguments to a shell, so remote commands avoid quotes.
flutter_version() { sed -n 's/.*"frameworkVersion": *"\([^"]*\)".*/\1/p'; }
local_flutter="$(flutter_version < "$HOME/flutter/bin/cache/flutter.version.json")"
remote_flutter="$("${WSL[@]}" -- cat /root/flutter/bin/cache/flutter.version.json | tr -d '\r' | flutter_version)"
if [[ "$local_flutter" != "$remote_flutter" ]]; then
  echo "WSL Flutter is $remote_flutter but this server has $local_flutter. Recopy the SDK (see the header)." >&2
  exit 1
fi

# The folder persists so .dart_tool stays warm. Source folders are replaced
# whole so files deleted here do not linger there.
"${WSL[@]}" -- mkdir -p /root/socketagent-app-test
"${WSL[@]}" -- rm -rf /root/socketagent-app-test/lib /root/socketagent-app-test/test /root/socketagent-app-test/test_support /root/socketagent-app-test/assets /root/socketagent-app-test/scripts
tar cf - -C "$APP_DIR" --exclude='.git' --exclude='build' --exclude='.dart_tool' \
  --exclude='.flutter-plugins-dependencies' --exclude='windows/flutter/ephemeral' \
  --exclude='android' --exclude='play-store' --exclude='.artifacts' . |
  "${WSL[@]}" -- tar xf - -C /root/socketagent-app-test

# Flutter warns on every run as root; the warning is noise here.
"${WSL[@]}" --cd /root/socketagent-app-test -- /root/flutter/bin/flutter test -j 18 --reporter failures-only "$@" 2>&1 |
  grep -v -e 'run flutter as root' -e 'superuser privileges' -e '^ *$'
exit "${PIPESTATUS[0]}"
