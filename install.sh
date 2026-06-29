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

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  if command -v readlink >/dev/null 2>&1; then
    SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH" 2>/dev/null || echo "$SCRIPT_PATH")"
  fi
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi

require_git_checkout() {
  local dir="$1"
  if ! command -v git >/dev/null 2>&1; then
    echo "SocketAgent requires git and must be installed from a git checkout." >&2
    echo "Install git, then run: git clone $REPO_URL" >&2
    exit 1
  fi
  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "SocketAgent must be installed from a git checkout; zip/archive installs are not supported." >&2
    echo "Run: git clone $REPO_URL" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<EOF
SocketAgent installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash -s -- --backends codex
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
  if [[ -r /dev/tty ]]; then
    exec bash "$SCRIPT_DIR/install-server.sh" "$@" </dev/tty
  fi
  exec bash "$SCRIPT_DIR/install-server.sh" "$@"
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "SocketAgent installer requires '$1' on PATH." >&2
    echo "Install '$1' and rerun this command." >&2
    exit 1
  fi
}

need_cmd git

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
if [[ -r /dev/tty ]]; then
  exec bash ./install-server.sh "$@" </dev/tty
fi
exec bash ./install-server.sh "$@"
