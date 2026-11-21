#!/usr/bin/env bash
# Builds the Flutter web app on the build machine's WSL Ubuntu (the same
# Flutter copy test-app.sh uses) and brings build/web back here.
#
# Usage:
#   ./build-app.sh --web
#   ./build-web-app.sh [--deploy] [extra flutter build web flags]
#
# Output: <app>/build/web, plus build/web.sha256 listing every file's hash so
# a release can publish what it serves.
#
# --deploy publishes https://socketagent.rbno.net. It needs a clean app tree
# at a commit on origin/master, builds the release image from
# <app>/web-host on the production server as
# localhost:5000/socketagent-web:<commit>, points the Coolify application at
# that tag, deploys, and checks the live files against build/web.sha256.
# Roll back by setting the previous tag in Coolify and redeploying.
set -euo pipefail
deploy=0
args=()
for arg in "$@"; do
  if [[ "$arg" == --deploy ]]; then deploy=1; else args+=("$arg"); fi
done
set -- "${args[@]+"${args[@]}"}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SOCKETAGENT_APP_DIR:-$(dirname "$ROOT")/socketagent-app}"
HOST="${SOCKETAGENT_TEST_HOST:-billy@10.10.10.69}"
WSL=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" wsl.exe -d Ubuntu)
REMOTE=/root/socketagent-app-web
PROD=(ssh -o BatchMode=yes -i "$HOME/.ssh/hetzner_prod_ed25519" deploy@5.78.209.159)
COOLIFY=https://deploy.rubanoenterprises.com/api/v1
WEB_APP_UUID=9ayzva1sh7jvhevwnubsyaml
SITE=https://socketagent.rbno.net

if [[ "$deploy" == 1 ]]; then
  for arg in "$@"; do
    [[ "$arg" == --profile ]] && { echo "--deploy builds release only." >&2; exit 1; }
  done
  if [[ -n "$(git -C "$APP_DIR" status --porcelain)" ]]; then
    echo "The app tree has uncommitted changes. Commit and push first." >&2
    exit 1
  fi
  git -C "$APP_DIR" fetch -q origin master
  revision="$(git -C "$APP_DIR" rev-parse HEAD)"
  if ! git -C "$APP_DIR" merge-base --is-ancestor "$revision" origin/master; then
    echo "App commit $revision is not on origin/master. Push it first." >&2
    exit 1
  fi
fi

flutter_version() { sed -n 's/.*"frameworkVersion": *"\([^"]*\)".*/\1/p'; }
local_flutter="$(flutter_version < "$HOME/flutter/bin/cache/flutter.version.json")"
remote_flutter="$("${WSL[@]}" -- cat /root/flutter/bin/cache/flutter.version.json | tr -d '\r' | flutter_version)"
if [[ "$local_flutter" != "$remote_flutter" ]]; then
  echo "WSL Flutter is $remote_flutter but this server has $local_flutter. Recopy the SDK (see test-app.sh)." >&2
  exit 1
fi

# The folder persists so .dart_tool stays warm. Source folders are replaced
# whole so files deleted here do not linger there.
"${WSL[@]}" -- mkdir -p "$REMOTE"
"${WSL[@]}" -- rm -rf "$REMOTE/lib" "$REMOTE/web" "$REMOTE/assets" "$REMOTE/third_party" "$REMOTE/build/web"
tar cf - -C "$APP_DIR" --exclude='.git' --exclude='build' --exclude='.dart_tool' \
  --exclude='.flutter-plugins-dependencies' --exclude='windows' --exclude='android' \
  --exclude='ios' --exclude='test' --exclude='test_support' --exclude='play-store' \
  --exclude='.artifacts' . |
  "${WSL[@]}" -- tar xf - -C "$REMOTE"

# --profile keeps names readable for debugging; release is the default.
mode=--release
for arg in "$@"; do [[ "$arg" == --profile ]] && mode=; done
"${WSL[@]}" --cd "$REMOTE" -- /root/flutter/bin/flutter build web $mode --no-wasm-dry-run --no-web-resources-cdn --dart-define=SOCKETAGENT_DISTRIBUTION=web "$@" 2>&1 |
  grep -v -e 'run flutter as root' -e 'superuser privileges' -e '^ *$'
status="${PIPESTATUS[0]}"
[[ "$status" == 0 ]] || exit "$status"

rm -rf "$APP_DIR/build/web"
mkdir -p "$APP_DIR/build/web"
"${WSL[@]}" -- tar cf - -C "$REMOTE/build/web" . | tar xf - -C "$APP_DIR/build/web"
(cd "$APP_DIR/build/web" && find . -type f | sort | xargs sha256sum) > "$APP_DIR/build/web.sha256"
echo "Web app: $APP_DIR/build/web ($(du -sh "$APP_DIR/build/web" | cut -f1))"

[[ "$deploy" == 1 ]] || exit 0

# The token stays out of argument lists: curl reads it from stdin.
token_file="$(ls "$HOME"/.socket-agent/secrets/project/general-dev_*/COOLIFY_API_TOKEN_sec_* | head -1)"
coolify() {
  local method="$1" path="$2"
  shift 2
  printf 'header = "Authorization: Bearer %s"\n' "$(cat "$token_file")" |
    curl -sf -K - -X "$method" -H 'Content-Type: application/json' "$COOLIFY$path" "$@"
}

image="localhost:5000/socketagent-web:$revision"
stage="/tmp/socketagent-web-$revision"
echo "Building $image on the production server"
"${PROD[@]}" "rm -rf '$stage' && mkdir -p '$stage/site'"
tar cf - -C "$APP_DIR/web-host" . | "${PROD[@]}" "tar xf - -C '$stage'"
tar cf - -C "$APP_DIR/build/web" . | "${PROD[@]}" "tar xf - -C '$stage/site'"
"${PROD[@]}" "docker build -q --build-arg REVISION='$revision' -t '$image' '$stage' && docker push -q '$image' && rm -rf '$stage'"

coolify PATCH "/applications/$WEB_APP_UUID" -d "{\"docker_registry_image_tag\":\"$revision\"}" >/dev/null
deployment="$(coolify POST "/deploy?uuid=$WEB_APP_UUID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployments"][0]["deployment_uuid"])')"
echo "Coolify deployment $deployment"
for _ in $(seq 1 60); do
  status="$(coolify GET "/deployments/$deployment" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))')"
  [[ "$status" == finished ]] && break
  [[ "$status" == failed || "$status" == cancelled* ]] && { echo "Deployment $status" >&2; exit 1; }
  sleep 5
done
[[ "$status" == finished ]] || { echo "Deployment still $status after 5 minutes" >&2; exit 1; }

# Every file the site serves must be the one built here.
mismatch=0
while read -r hash file; do
  live="$(curl -sf "$SITE/${file#./}" | sha256sum | cut -d' ' -f1)"
  [[ "$live" == "$hash" ]] || { echo "Live $file differs" >&2; mismatch=1; }
done < "$APP_DIR/build/web.sha256"
[[ "$mismatch" == 0 ]] || exit 1
echo "Live at $SITE: app $revision"
