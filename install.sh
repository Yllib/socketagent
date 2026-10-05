#!/usr/bin/env bash
set -euo pipefail

# SocketAgent one-line installer.
#
# Intended for:
#   curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
#
# When run from a cloned repo, this delegates directly to install-server.sh.
# When run from curl, it obtains the full repository first.

REPO_URL="${SOCKETAGENT_REPO_URL:-https://github.com/Yllib/socketagent.git}"
INSTALL_DIR="${SOCKETAGENT_INSTALL_DIR:-$HOME/socketagent}"
BRANCH="${SOCKETAGENT_BRANCH:-master}"

# Every failure without its own message ends here, so the install never stops
# on a bare exit status. install-server.sh has its own, more detailed version.
on_install_error() {
  local status=$? command=$BASH_COMMAND
  [[ $BASH_SUBSHELL -eq 0 ]] || return "$status"
  echo "" >&2
  echo "SocketAgent install stopped. This command failed with exit status $status:" >&2
  echo "  $command" >&2
  echo "Fix the problem above, then rerun the install command." >&2
  exit "$status"
}
set -E
trap on_install_error ERR

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  if command -v readlink >/dev/null 2>&1; then
    SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH" 2>/dev/null || echo "$SCRIPT_PATH")"
  fi
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "SocketAgent needs to install git, but sudo is not available." >&2
    echo "Install git manually, then rerun this command." >&2
    exit 1
  fi
}

install_git_if_missing() {
  if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
    return
  fi

  echo "Git not found. Installing git..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "macOS will open the Command Line Tools installer. Complete that dialog to continue."
    xcode-select --install >/dev/null 2>&1 || true
    local waited=0
    while ! git --version >/dev/null 2>&1; do
      if (( waited >= 1800 )); then
        echo "Timed out waiting for the macOS Command Line Tools installation." >&2
        echo "Complete the installation, then rerun this command." >&2
        exit 1
      fi
      sleep 10
      waited=$((waited + 10))
    done
  elif command -v apt-get >/dev/null 2>&1; then
    # A package left half installed by something else fails every apt run, so
    # judge success by whether git works afterward.
    run_as_root apt-get -o DPkg::Lock::Timeout=120 update || echo "apt-get update reported an error. Using the existing package lists." >&2
    if ! run_as_root apt-get -o DPkg::Lock::Timeout=120 install -y git ca-certificates; then
      echo "apt reported an error. If it names a package other than git, fix it with:" >&2
      echo "  sudo dpkg --configure -a && sudo apt -f install" >&2
    fi
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y git
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --noconfirm git
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install git
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add git
  elif command -v brew >/dev/null 2>&1; then
    brew install git
  else
    echo "SocketAgent could not find a supported package manager to install git." >&2
    echo "Install git manually, then rerun this command." >&2
    exit 1
  fi

  if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
    echo "Git installation finished, but git is still not on PATH." >&2
    echo "Open a new terminal and rerun the install command." >&2
    exit 1
  fi
}

require_git_checkout() {
  local dir="$1"
  install_git_if_missing
  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "SocketAgent must be installed from a git checkout; zip/archive installs are not supported." >&2
    echo "Run: git clone $REPO_URL" >&2
    exit 1
  fi
}

has_controlling_tty() {
  [[ -c /dev/tty ]] && { : </dev/tty; } 2>/dev/null
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<EOF
SocketAgent installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
  bash install.sh

Environment:
  SOCKETAGENT_INSTALL_DIR   Install directory, default: ~/socketagent
  SOCKETAGENT_REPO_URL      Git repo URL, default: https://github.com/Yllib/socketagent.git
  SOCKETAGENT_BRANCH        Git branch, default: master
EOF
  exit 0
fi

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/install-server.sh" && -d "$SCRIPT_DIR/server" ]]; then
  require_git_checkout "$SCRIPT_DIR"
  if has_controlling_tty; then
    exec bash "$SCRIPT_DIR/install-server.sh" "$@" </dev/tty
  fi
  exec bash "$SCRIPT_DIR/install-server.sh" "$@"
fi

install_git_if_missing

echo "SocketAgent installer"
echo "Repo: $REPO_URL"
echo "Install dir: $INSTALL_DIR"
echo ""

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Existing SocketAgent repo found. Updating..."
  git -C "$INSTALL_DIR" fetch --prune origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "Install directory exists but is not a git repo: $INSTALL_DIR" >&2
  echo "Choose another directory with SOCKETAGENT_INSTALL_DIR=/path/to/socketagent." >&2
  exit 1
else
  echo "Cloning SocketAgent..."
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
if has_controlling_tty; then
  exec bash ./install-server.sh "$@" </dev/tty
fi
exec bash ./install-server.sh "$@"
