#!/usr/bin/env bash
set -euo pipefail

# Ensure Codex's Linux sandbox dependency is installed and usable.
#
# --interactive is used by the foreground installer and may prompt for sudo.
# --auto is used by the SocketAgent user service and only uses non-interactive
# elevation, so server startup can never hang waiting for a password.
# --check performs the capability probe without changing the system.

MODE="auto"
case "${1:-}" in
  --interactive) MODE="interactive" ;;
  --auto|"") MODE="auto" ;;
  --check) MODE="check" ;;
  *) echo "Unknown option: $1" >&2; exit 64 ;;
esac

if [[ "$(uname -s)" != "Linux" ]]; then
  exit 0
fi

log() {
  printf '%s\n' "[Codex sandbox] $*"
}

probe_bwrap() {
  command -v bwrap >/dev/null 2>&1 || return 127
  bwrap \
    --ro-bind / / \
    --proc /proc \
    --dev /dev \
    --unshare-all \
    --die-with-parent \
    -- true >/dev/null 2>&1
}

if probe_bwrap; then
  log "Bubblewrap is installed and usable ($(bwrap --version 2>/dev/null || command -v bwrap))."
  exit 0
fi

if [[ "$MODE" == "check" ]]; then
  if command -v bwrap >/dev/null 2>&1; then
    log "Bubblewrap is installed but cannot create the required user namespace."
  else
    log "Bubblewrap is not installed."
  fi
  exit 1
fi

can_elevate() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  command -v sudo >/dev/null 2>&1 || return 1
  if [[ "$MODE" == "interactive" ]]; then
    sudo -v
  else
    sudo -n true >/dev/null 2>&1
  fi
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif [[ "$MODE" == "interactive" ]]; then
    sudo "$@"
  else
    sudo -n "$@"
  fi
}

if ! can_elevate; then
  log "Automatic repair needs administrator access. Run: sudo apt install bubblewrap (or your distribution's equivalent)." >&2
  exit 3
fi

install_bubblewrap() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y bubblewrap
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y bubblewrap
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y bubblewrap
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --noconfirm bubblewrap
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install bubblewrap
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add bubblewrap
  else
    log "No supported package manager was found. Install the package named 'bubblewrap' manually." >&2
    return 1
  fi
}

if ! command -v bwrap >/dev/null 2>&1; then
  log "Installing Bubblewrap for Codex..."
  install_bubblewrap
fi

if probe_bwrap; then
  log "Bubblewrap was repaired successfully."
  exit 0
fi

# Ubuntu 24.04 can restrict unprivileged user namespaces even after bwrap is
# installed. OpenAI recommends loading the distribution's bwrap AppArmor
# profile rather than disabling that protection globally.
repair_apparmor_profile() {
  command -v apt-get >/dev/null 2>&1 || return 1
  [[ -r /sys/module/apparmor/parameters/enabled ]] || return 1
  grep -qi '^Y' /sys/module/apparmor/parameters/enabled || return 1

  log "Bubblewrap is installed but blocked; installing the AppArmor profile..."
  run_as_root apt-get install -y apparmor-profiles apparmor-utils

  local source_profile="/usr/share/apparmor/extra-profiles/bwrap-userns-restrict"
  local target_profile="/etc/apparmor.d/bwrap-userns-restrict"
  [[ -f "$source_profile" ]] || return 1
  run_as_root install -m 0644 "$source_profile" "$target_profile"
  run_as_root apparmor_parser -r "$target_profile"
}

repair_apparmor_profile || true

if probe_bwrap; then
  log "Bubblewrap and its AppArmor profile are usable."
  exit 0
fi

log "Bubblewrap is installed but the host still blocks its sandbox. WSL1 is unsupported; containers must allow user namespaces and the capabilities required by bwrap." >&2
exit 4
