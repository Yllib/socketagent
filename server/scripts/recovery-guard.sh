#!/usr/bin/env bash
#
# recovery-guard.sh — OS-level deadman recovery for SocketAgent restarts.
#
# Arm this before an update/restart operation that may stop the server. If the
# server does not come back before the delay expires, the guard runs outside the
# SocketAgent service cgroup and tries to recover the user service.

set -euo pipefail

SCRIPT_PATH="$(readlink -f "$0")"
SERVER_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
STORE_DIR="${SOCKETAGENT_DATA_DIR:-$HOME/.socket-agent}"
if [[ ! -d "$STORE_DIR" && -d "$HOME/.claude-assistant" ]]; then
  STORE_DIR="$HOME/.claude-assistant"
fi
RECOVERY_DIR="$STORE_DIR/recovery"
LOG_FILE="$RECOVERY_DIR/recovery.log"

log() {
  mkdir -p "$RECOVERY_DIR"
  printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

detect_service_name() {
  if systemctl --user list-unit-files socketagent.service >/dev/null 2>&1; then
    echo "socketagent"
  else
    echo "socketclaude"
  fi
}

read_port() {
  local env_file="$SERVER_DIR/.env"
  local port
  port="$(grep -E '^PORT=' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  echo "${port:-8085}"
}

unit_safe_id() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-'
}

marker_file() {
  printf '%s/%s.armed' "$RECOVERY_DIR" "$1"
}

port_is_open() {
  local port="$1"
  timeout 2 bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
}

cleanup_startup_lock() {
  local mode="${1:-safe}"
  local lock_dir="$SERVER_DIR/.startup-repair.lock"
  local pid_file="$lock_dir/pid"
  [[ -d "$lock_dir" ]] || return 0

  if [[ "$mode" == "force" ]]; then
    log "Removing startup repair lock before recovery restart at $lock_dir"
    rm -rf "$lock_dir"
    return 0
  fi

  local pid=""
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    log "Startup repair lock is held by live pid=$pid; leaving it alone"
    return 0
  fi

  if pgrep -u "$(id -u)" -f 'npm ci|npx tsc|git reset|git fetch' >/dev/null 2>&1; then
    log "Startup/update process appears active; leaving startup repair lock alone"
    return 0
  fi

  log "Removing stale startup repair lock at $lock_dir"
  rm -rf "$lock_dir"
}

arm_guard() {
  local reason="${1:-restart}"
  local delay="${2:-180}"
  local service port id unit marker
  service="$(detect_service_name)"
  port="$(read_port)"
  id="$(date +%s)-$$-$(unit_safe_id "$reason")"
  unit="socketagent-recovery-$(unit_safe_id "$id")"
  marker="$(marker_file "$id")"

  mkdir -p "$RECOVERY_DIR"
  printf 'reason=%q\nservice=%q\nport=%q\nserver_dir=%q\narmed_at=%q\n' \
    "$reason" "$service" "$port" "$SERVER_DIR" "$(date -Is)" > "$marker"

  if ! systemd-run --user \
    --unit="$unit" \
    --collect \
    --on-active="${delay}s" \
    "$SCRIPT_PATH" run "$id" "$service" "$port" "$SERVER_DIR" >/dev/null 2>&1; then
    rm -f "$marker"
    log "Failed to arm recovery guard reason=$reason delay=${delay}s"
    return 1
  fi

  log "Armed recovery guard id=$id reason=$reason service=$service port=$port delay=${delay}s"
  echo "$id"
}

cancel_guard() {
  local id="${1:-}"
  [[ -n "$id" ]] || return 0
  local unit="socketagent-recovery-$(unit_safe_id "$id")"
  rm -f "$(marker_file "$id")"
  systemctl --user stop "${unit}.timer" "${unit}.service" >/dev/null 2>&1 || true
  log "Cancelled recovery guard id=$id"
}

run_guard() {
  local id="$1"
  local service="${2:-$(detect_service_name)}"
  local port="${3:-$(read_port)}"
  local marker
  marker="$(marker_file "$id")"

  if [[ ! -f "$marker" ]]; then
    log "Recovery guard id=$id skipped; marker is gone"
    return 0
  fi

  if port_is_open "$port"; then
    log "Recovery guard id=$id complete; server is already listening on port $port"
    rm -f "$marker"
    return 0
  fi

  log "Recovery guard id=$id firing; service=$service port=$port is not listening"
  cleanup_startup_lock force
  systemctl --user reset-failed "${service}.service" >/dev/null 2>&1 || true
  systemctl --user restart "${service}.service" || systemctl --user start "${service}.service"

  for _ in $(seq 1 60); do
    if port_is_open "$port"; then
      log "Recovery guard id=$id recovered service=$service on port=$port"
      rm -f "$marker"
      return 0
    fi
    sleep 1
  done

  log "Recovery guard id=$id failed; service=$service did not listen on port=$port after restart"
  return 1
}

case "${1:-}" in
  arm)
    arm_guard "${2:-restart}" "${3:-180}"
    ;;
  cancel)
    cancel_guard "${2:-}"
    ;;
  run)
    run_guard "${2:?missing recovery id}" "${3:-}" "${4:-}" "${5:-}"
    ;;
  *)
    echo "Usage: $0 arm [reason] [delay_seconds] | cancel <id> | run <id> [service] [port] [server_dir]" >&2
    exit 2
    ;;
esac
