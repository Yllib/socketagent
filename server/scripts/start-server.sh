#!/usr/bin/env bash
#
# start-server.sh — systemd entrypoint with startup self-repair
#
# This runs before dist/index.js so dependency/build corruption can be fixed
# even when the Node server itself cannot start.

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SERVER_DIR"

NODE_BIN="${SOCKETAGENT_NODE:-node}"
NPM_BIN="${SOCKETAGENT_NPM:-npm}"
NPX_BIN="${SOCKETAGENT_NPX:-npx}"
RETRY_WINDOW_SECONDS="${SOCKETAGENT_STARTUP_REPAIR_RETRY_SECONDS:-300}"
LOCK_DIR="$SERVER_DIR/.startup-repair.lock"
LOCK_HELD=false

log() {
  echo "[startup] $*"
}

mark_failure() {
  local name="$1"
  date +%s > "$SERVER_DIR/.startup-${name}-failed-at"
}

clear_failure() {
  local name="$1"
  rm -f "$SERVER_DIR/.startup-${name}-failed-at"
}

recent_failure() {
  local name="$1"
  local stamp="$SERVER_DIR/.startup-${name}-failed-at"
  [[ -f "$stamp" ]] || return 1

  local last now age
  last="$(cat "$stamp" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  age=$((now - last))

  if (( age < RETRY_WINDOW_SECONDS )); then
    log "Previous ${name} repair failed ${age}s ago; waiting before retrying to avoid a restart storm"
    return 0
  fi
  return 1
}

acquire_lock() {
  if [[ "$LOCK_HELD" == "true" ]]; then
    return
  fi

  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if (( waited >= 60 )); then
      log "Timed out waiting for startup repair lock"
      exit 1
    fi
    log "Waiting for another startup repair to finish..."
    sleep 2
    waited=$((waited + 2))
  done
  LOCK_HELD=true
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

deps_resolve() {
  "$NODE_BIN" - <<'NODE'
const modules = [
  "@anthropic-ai/claude-agent-sdk",
  "dotenv",
  "tweetnacl",
  "ws",
  "zod",
];

for (const name of modules) {
  require.resolve(name);
}
NODE
}

deps_need_install() {
  [[ -d node_modules ]] || return 0
  [[ -f node_modules/.package-lock.json ]] || return 0
  if [[ -f package-lock.json && package-lock.json -nt node_modules/.package-lock.json ]]; then
    return 0
  fi
  if [[ -f package.json && package.json -nt node_modules/.package-lock.json ]]; then
    return 0
  fi

  local deps_log="${TMPDIR:-/tmp}/socketagent-startup-deps-$$.log"
  deps_resolve >"$deps_log" 2>&1 && return 1
  log "Dependency check failed:"
  sed 's/^/[startup]   /' "$deps_log" || true
  return 0
}

run_repair() {
  local name="$1"
  shift

  if recent_failure "$name"; then
    exit 1
  fi

  log "Running repair: $*"
  if "$@"; then
    clear_failure "$name"
    log "Repair complete: $name"
  else
    mark_failure "$name"
    log "Repair failed: $name"
    exit 1
  fi
}

build_needs_compile() {
  [[ -f dist/index.js ]] || return 0
  if [[ -f tsconfig.json && tsconfig.json -nt dist/index.js ]]; then
    return 0
  fi

  if find src -type f -name '*.ts' -newer dist/index.js -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi

  return 1
}

if deps_need_install; then
  acquire_lock
  if deps_need_install; then
    run_repair "npm" "$NPM_BIN" ci --include=optional
  fi
fi

if build_needs_compile; then
  acquire_lock
  if build_needs_compile; then
    run_repair "tsc" "$NPX_BIN" tsc
  fi
fi

log "Starting SocketAgent server"
exec "$NODE_BIN" "$SERVER_DIR/dist/index.js"
