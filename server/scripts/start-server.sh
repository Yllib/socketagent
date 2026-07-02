#!/usr/bin/env bash
#
# start-server.sh — systemd entrypoint with startup self-repair
#
# This runs before dist/index.js so dependency/build corruption can be fixed
# even when the Node server itself cannot start.

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SERVER_DIR"

NODE_MIN_VERSION="${SOCKETAGENT_NODE_MIN_VERSION:-22}"
NODE_RUNTIME_VERSION="${SOCKETAGENT_NODE_VERSION:-22.22.1}"
USER_NODE_DIR="${SOCKETAGENT_NODE_DIR:-$HOME/.local/share/socketagent/node}"
NODE_BIN=""
NPM_BIN=""
NPX_BIN=""
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

node_major_version() {
  local candidate="$1"
  local version
  version="$("$candidate" --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)"
  [[ "$version" =~ ^[0-9]+$ ]] || return 1
  echo "$version"
}

node_is_usable() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  if [[ "$candidate" != */* ]]; then
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
  fi
  [[ -x "$candidate" ]] || return 1

  local major
  major="$(node_major_version "$candidate")" || return 1
  (( major >= NODE_MIN_VERSION ))
}

set_node_runtime() {
  local candidate="$1"
  if [[ "$candidate" != */* ]]; then
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
  fi

  NODE_BIN="$candidate"
  local node_dir
  node_dir="$(dirname "$NODE_BIN")"
  export PATH="$node_dir:$PATH"

  NPM_BIN="$node_dir/npm"
  NPX_BIN="$node_dir/npx"

  if [[ -n "${SOCKETAGENT_NPM:-}" && -x "${SOCKETAGENT_NPM:-}" ]]; then
    NPM_BIN="$SOCKETAGENT_NPM"
  elif [[ ! -x "$NPM_BIN" ]]; then
    NPM_BIN="$(command -v npm 2>/dev/null || true)"
  fi

  if [[ -n "${SOCKETAGENT_NPX:-}" && -x "${SOCKETAGENT_NPX:-}" ]]; then
    NPX_BIN="$SOCKETAGENT_NPX"
  elif [[ ! -x "$NPX_BIN" ]]; then
    NPX_BIN="$(command -v npx 2>/dev/null || true)"
  fi

  log "Using Node.js $("$NODE_BIN" --version) at $NODE_BIN"
}

install_managed_node() {
  command -v curl >/dev/null 2>&1 || {
    log "curl is required to install managed Node.js"
    return 1
  }
  command -v tar >/dev/null 2>&1 || {
    log "tar is required to install managed Node.js"
    return 1
  }

  local node_arch
  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64) node_arch="arm64" ;;
    armv7l) node_arch="armv7l" ;;
    *)
      log "Unsupported architecture for managed Node.js: $(uname -m)"
      return 1
      ;;
  esac

  local tarball url tmp
  tarball="node-v${NODE_RUNTIME_VERSION}-linux-${node_arch}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${tarball}"
  tmp="${TMPDIR:-/tmp}/${tarball}.$$"

  log "Installing managed Node.js v${NODE_RUNTIME_VERSION} to $USER_NODE_DIR"
  curl -fSL --retry 3 --connect-timeout 15 -o "$tmp" "$url"

  rm -rf "$USER_NODE_DIR"
  mkdir -p "$USER_NODE_DIR"
  tar -xJf "$tmp" -C "$USER_NODE_DIR" --strip-components=1
  rm -f "$tmp"

  node_is_usable "$USER_NODE_DIR/bin/node"
}

select_node_runtime() {
  local configured_node="${SOCKETAGENT_NODE:-}"
  if node_is_usable "$configured_node"; then
    set_node_runtime "$configured_node"
    return
  fi

  if [[ -n "$configured_node" ]]; then
    log "Configured Node.js at $configured_node is missing or older than v${NODE_MIN_VERSION}; checking managed runtime"
  fi

  if node_is_usable "$USER_NODE_DIR/bin/node"; then
    set_node_runtime "$USER_NODE_DIR/bin/node"
    return
  fi

  local system_node
  system_node="$(command -v node 2>/dev/null || true)"
  if node_is_usable "$system_node"; then
    set_node_runtime "$system_node"
    return
  fi

  if [[ -n "$system_node" ]]; then
    log "System Node.js at $system_node is missing or older than v${NODE_MIN_VERSION}; installing managed runtime"
  else
    log "Node.js v${NODE_MIN_VERSION}+ not found; installing managed runtime"
  fi

  acquire_lock
  if ! node_is_usable "$USER_NODE_DIR/bin/node"; then
    run_repair "node" install_managed_node
  fi
  set_node_runtime "$USER_NODE_DIR/bin/node"
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

select_node_runtime

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
