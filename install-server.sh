#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════
#  SocketAgent Linux/macOS Server Installer
# ══════════════════════════════════════════════
#
# Installs everything needed to run SocketAgent server on Linux or macOS:
# Node.js, Claude Code CLI, OpenAI Codex CLI, server dependencies,
# configuration, and an OS-native background service.
#
# Usage:
#   bash install-server.sh [--reset-pairing] [--port PORT] [--backends claude|codex|both|installed] [--non-interactive]
#
# Re-running is safe — existing tokens and pairings are preserved.

RELAY_URL="wss://relay.jarofdirt.info"
CODEX_DEVICE_URL="https://chatgpt.com/codex/device"
SERVICE_NAME="socketagent"
NODE_MIN_VERSION=22
NODE_RUNTIME_VERSION="${SOCKETAGENT_NODE_VERSION:-22.22.1}"
PORT=8085
RESET_PAIRING=false
BACKENDS=""
INSTALL_BACKENDS=""
INSTALL_CLAUDE=false
INSTALL_CODEX=false
SERVER_BUILD_DONE=false
NON_INTERACTIVE=false
SKIP_CLAUDE_LOGIN=false
SKIP_CODEX_LOGIN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --reset-pairing) RESET_PAIRING=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --backend|--backends) BACKENDS="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --skip-claude-login) SKIP_CLAUDE_LOGIN=true; shift ;;
    --skip-codex-login) SKIP_CODEX_LOGIN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Paths
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$REPO_ROOT/server"
ENV_FILE="$SERVER_DIR/.env"
SOCKET_AGENT_HOME="${SOCKET_AGENT_HOME:-$HOME/.socket-agent}"
DATA_DIR="${SOCKETAGENT_DATA_DIR:-$SOCKET_AGENT_HOME}"
LEGACY_DATA_DIR="$HOME/.claude-assistant"
KEYS_FILE="$DATA_DIR/relay-keys.json"
SETUP_SCRIPT="$SERVER_DIR/scripts/setup.js"
USER_NODE_DIR="${SOCKETAGENT_NODE_DIR:-$HOME/.local/share/socketagent/node}"
NPM_GLOBAL_DIR="${SOCKETAGENT_NPM_GLOBAL_DIR:-$SOCKET_AGENT_HOME/toolchains/npm-global}"
NPM_BIN_DIR="$NPM_GLOBAL_DIR/bin"
OS_NAME="$(uname -s)"

case "$OS_NAME" in
  Linux|Darwin) ;;
  *)
    echo "Unsupported operating system: $OS_NAME" >&2
    echo "Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

if [[ -x "$USER_NODE_DIR/bin/node" ]]; then
  export PATH="$USER_NODE_DIR/bin:$PATH"
fi
mkdir -p "$NPM_BIN_DIR"
export NPM_CONFIG_PREFIX="$NPM_GLOBAL_DIR"
export PATH="$NPM_BIN_DIR:$PATH"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

phase() { echo -e "\n${CYAN}--- $1 ---${NC}"; }
ok()    { echo -e "  ${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "  ${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "  ${RED}[X]${NC} $1"; }

prompt_read() {
  local prompt="$1"
  local __resultvar="$2"
  local value=""
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    fail "Non-interactive mode cannot prompt: $prompt"
    exit 1
  fi
  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt" value </dev/tty
  elif ! read -r -p "$prompt" value; then
    fail "Interactive input is unavailable. Re-run with --backends claude, --backends codex, or --backends both."
    exit 1
  fi
  printf -v "$__resultvar" '%s' "$value"
}

require_git_checkout() {
  if ! command -v git >/dev/null 2>&1; then
    fail "Git is required. SocketAgent must be installed from a git checkout."
    echo "  Install git, then run:"
    echo "    git clone https://github.com/Yllib/socketagent.git"
    echo "    cd socketagent"
    echo "    bash install.sh"
    exit 1
  fi
  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "SocketAgent must be installed from a git checkout; zip/archive installs are not supported."
    echo "  Run:"
    echo "    git clone https://github.com/Yllib/socketagent.git"
    echo "    cd socketagent"
    echo "    bash install.sh"
    exit 1
  fi
}

ensure_shell_path() {
  local path_entry="$1"
  local label="$2"
  case ":$PATH:" in
    *":$path_entry:"*) return ;;
  esac

  local shell_rc="$HOME/.profile"
  case "$(basename "${SHELL:-}")" in
    bash) shell_rc="$HOME/.bashrc" ;;
    zsh) shell_rc="$HOME/.zshrc" ;;
  esac

  if [[ -f "$shell_rc" ]] && ! grep -q "$path_entry" "$shell_rc"; then
    printf '\n# %s\nexport PATH="%s:$PATH"\n' "$label" "$path_entry" >> "$shell_rc"
    ok "Added $path_entry to PATH in $shell_rc"
  else
    warn "Add this to your shell profile if needed: export PATH=\"$path_entry:\$PATH\""
  fi
}

phase "Repository Check"
require_git_checkout
ok "Repository checkout verified"

select_backends() {
  local value
  value=$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')

  if [[ -z "$value" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      value="both"
    else
      phase "Backend Toolchain Setup"
      echo "  Which managed agent toolchain(s) should SocketAgent install or repair now?"
      echo "    1) Codex only"
      echo "    2) Claude only"
      echo "    3) Both Claude and Codex"
      echo ""
      prompt_read "  Choose [3]: " value
      value=$(echo "${value:-3}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    fi
  fi

  case "$value" in
    1|codex|openai)
      INSTALL_BACKENDS="codex"
      ;;
    2|claude|anthropic)
      INSTALL_BACKENDS="claude"
      ;;
    3|both|all|claude,codex|codex,claude)
      INSTALL_BACKENDS="claude,codex"
      ;;
    auto|installed|existing)
      INSTALL_BACKENDS="$(detect_installed_backends)"
      ;;
    *)
      fail "Invalid managed toolchain selection: ${1:-$value}. Use claude, codex, both, or installed."
      exit 1
      ;;
  esac

  if [[ ",$INSTALL_BACKENDS," == *",claude,"* ]]; then INSTALL_CLAUDE=true; fi
  if [[ ",$INSTALL_BACKENDS," == *",codex,"* ]]; then INSTALL_CODEX=true; fi
}

detect_installed_backends() {
  local installed=()
  if command -v claude &>/dev/null; then
    installed+=("claude")
  fi
  if command -v codex &>/dev/null && codex app-server --help &>/dev/null; then
    installed+=("codex")
  fi
  if [[ ${#installed[@]} -eq 0 ]]; then
    fail "No installed SocketAgent backends found on PATH. Use --backends claude, --backends codex, or --backends both to install one."
    exit 1
  fi
  local IFS=,
  echo "${installed[*]}"
}

install_cli() {
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  ln -sf "$REPO_ROOT/bin/socketagent" "$bin_dir/socketagent"
  ln -sf "$REPO_ROOT/bin/socketagent" "$bin_dir/socketclaude"
  ok "Installed socketagent command to $bin_dir"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      warn "$bin_dir is not currently on PATH."
      local shell_rc="$HOME/.profile"
      case "$(basename "${SHELL:-}")" in
        bash) shell_rc="$HOME/.bashrc" ;;
        zsh) shell_rc="$HOME/.zshrc" ;;
      esac
      if [[ -f "$shell_rc" ]] && ! grep -q 'HOME/.local/bin' "$shell_rc"; then
        printf '\n# SocketAgent CLI\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$shell_rc"
        ok "Added ~/.local/bin to PATH in $shell_rc"
      else
        warn "Add this to your shell profile if needed: export PATH=\"\$HOME/.local/bin:\$PATH\""
      fi
      ;;
  esac
}

install_server_dependencies_and_build() {
  if [[ "$SERVER_BUILD_DONE" == "true" ]]; then
    ok "Server dependencies already installed and built"
    return
  fi

  echo "  Running npm install --include=optional..."
  (cd "$SERVER_DIR" && npm install --include=optional)
  ok "Dependencies installed"

  echo "  Compiling TypeScript..."
  (cd "$SERVER_DIR" && npx tsc)
  ok "Server built successfully"
  SERVER_BUILD_DONE=true
}

render_qr() {
  local payload="$1"
  (cd "$SERVER_DIR" && node -e "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>{c.split('\n').forEach(l=>console.log('  '+l))})" "$payload" 2>/dev/null) || \
    warn "QR code rendering failed. Open this link manually: $payload"
}

echo ""
echo -e "  ${CYAN}SocketAgent Installer${NC}"
echo -e "  ${CYAN}======================${NC}"
echo ""

# Verify repo structure
if [[ ! -d "$SERVER_DIR" ]] || [[ ! -f "$SERVER_DIR/package.json" ]]; then
  fail "Cannot find server/package.json. Run this script from the SocketAgent repo root."
  exit 1
fi

select_backends "$BACKENDS"
ok "Selected managed toolchains: $INSTALL_BACKENDS"

# ══════════════════════════════════════════════
#  Phase 1: Node.js
# ══════════════════════════════════════════════

phase "Phase 1: Node.js"

NEED_NODE_INSTALL=false
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [[ "$NODE_VERSION" -ge "$NODE_MIN_VERSION" ]]; then
    ok "Node.js $(node --version) already installed"
  else
    warn "Node.js v$(node --version) found but v$NODE_MIN_VERSION+ required. Upgrading..."
    NEED_NODE_INSTALL=true
  fi
else
  echo "  Node.js not found. Installing..."
  NEED_NODE_INSTALL=true
fi

if [[ "$NEED_NODE_INSTALL" == "true" ]]; then
  # Install a private Node.js runtime so service startup does not depend on a
  # package manager or the user's interactive shell configuration.
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    armv7l)
      if [[ "$OS_NAME" == "Darwin" ]]; then
        fail "Unsupported macOS architecture: $ARCH"
        exit 1
      fi
      NODE_ARCH="armv7l"
      ;;
    *) fail "Unsupported architecture: $ARCH"; exit 1 ;;
  esac

  NODE_INSTALL_DIR="$USER_NODE_DIR"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    NODE_TARBALL="node-v${NODE_RUNTIME_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  else
    NODE_TARBALL="node-v${NODE_RUNTIME_VERSION}-linux-${NODE_ARCH}.tar.xz"
  fi
  NODE_URL="https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${NODE_TARBALL}"

  NODE_TMP="${TMPDIR:-/tmp}/${NODE_TARBALL}.$$"
  echo "  Downloading Node.js v${NODE_RUNTIME_VERSION} for ${NODE_ARCH}..."
  curl -fSL --retry 3 --connect-timeout 15 --progress-bar -o "$NODE_TMP" "$NODE_URL"

  echo "  Installing to ${NODE_INSTALL_DIR}..."
  rm -rf "$NODE_INSTALL_DIR"
  mkdir -p "$NODE_INSTALL_DIR"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    tar -xzf "$NODE_TMP" -C "$NODE_INSTALL_DIR" --strip-components=1
  else
    tar -xJf "$NODE_TMP" -C "$NODE_INSTALL_DIR" --strip-components=1
  fi
  rm -f "$NODE_TMP"

  # Refresh PATH
  hash -r 2>/dev/null
  export PATH="$NODE_INSTALL_DIR/bin:$PATH"
  ensure_shell_path "$NODE_INSTALL_DIR/bin" "SocketAgent Node.js"

  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Install manually: https://nodejs.org/"
    exit 1
  fi

  # Verify version
  NODE_VERSION=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [[ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]]; then
    fail "Node.js $(node --version) installed but v$NODE_MIN_VERSION+ required."
    exit 1
  fi
  ok "Node.js $(node --version) installed"
fi # NEED_NODE_INSTALL

# npm is always included in the official Node.js tarball,
# but verify it's on PATH
if ! command -v npm &>/dev/null; then
  fail "npm not found despite Node.js being installed. Check your PATH."
  exit 1
fi
ensure_shell_path "$NPM_CONFIG_PREFIX/bin" "SocketAgent npm global tools"

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

phase "Phase 2: Claude Code CLI"

if [[ "$INSTALL_CLAUDE" != "true" ]]; then
  ok "Skipped (Claude not selected)"
else
  CLAUDE_BIN="$NPM_BIN_DIR/claude"
  if [[ -x "$CLAUDE_BIN" || -f "$CLAUDE_BIN" ]]; then
    CLAUDE_VER=$("$CLAUDE_BIN" --version 2>/dev/null || echo "unknown")
    ok "Managed Claude Code CLI already installed ($CLAUDE_VER)"
  else
    echo "  Installing managed Claude Code CLI..."
    npm install -g --include=optional @anthropic-ai/claude-code@latest
    hash -r 2>/dev/null
    if [[ ! -x "$CLAUDE_BIN" && ! -f "$CLAUDE_BIN" ]]; then
      fail "Claude Code CLI installation failed in $NPM_GLOBAL_DIR"
      exit 1
    fi
    ok "Managed Claude Code CLI installed ($("$CLAUDE_BIN" --version 2>/dev/null))"
  fi
fi

# ══════════════════════════════════════════════
#  Phase 3: Claude Code Authentication
# ══════════════════════════════════════════════

phase "Phase 3: Claude Code Authentication"

if [[ "$INSTALL_CLAUDE" != "true" ]]; then
  ok "Skipped (Claude not selected)"
else
  CLAUDE_DIR="$HOME/.claude"
  if [[ -f "$CLAUDE_DIR/credentials.json" ]] || [[ -f "$CLAUDE_DIR/.credentials.json" ]]; then
    ok "Claude Code credentials found"
  elif [[ "$SKIP_CLAUDE_LOGIN" == "true" || "$NON_INTERACTIVE" == "true" ]]; then
    warn "Claude Code is not authenticated. Skipping interactive login."
    echo "  Run 'claude auth login' later if this server should run Claude sessions."
  else
    warn "Claude Code is not authenticated."
    echo "  Running 'claude auth login' -- this will open your browser."
    echo "  Complete the login, then return to this terminal."
    echo ""
    prompt_read "  Press Enter to start login..." _
    claude auth login

    if [[ -f "$CLAUDE_DIR/credentials.json" ]] || [[ -f "$CLAUDE_DIR/.credentials.json" ]]; then
      ok "Authentication successful"
    else
      warn "Could not verify authentication. You can run 'claude login' later."
    fi
  fi
fi

# ══════════════════════════════════════════════
#  Phase 4: OpenAI Codex CLI
# ══════════════════════════════════════════════

phase "Phase 4: OpenAI Codex CLI"

if [[ "$INSTALL_CODEX" != "true" ]]; then
  ok "Skipped (Codex not selected)"
else
  NEED_CODEX_INSTALL=false
  CODEX_BIN="$NPM_BIN_DIR/codex"
  if [[ -x "$CODEX_BIN" || -f "$CODEX_BIN" ]]; then
    CODEX_VER=$("$CODEX_BIN" --version 2>/dev/null || echo "unknown")
    if "$CODEX_BIN" app-server --help &>/dev/null; then
      ok "Managed OpenAI Codex CLI already installed ($CODEX_VER)"
    else
      warn "Managed OpenAI Codex CLI found ($CODEX_VER) but app-server is unavailable. Updating..."
      NEED_CODEX_INSTALL=true
    fi
  else
    echo "  Installing managed OpenAI Codex CLI..."
    NEED_CODEX_INSTALL=true
  fi

  if [[ "$NEED_CODEX_INSTALL" == "true" ]]; then
    npm install -g --include=optional @openai/codex@latest
    hash -r 2>/dev/null
    if [[ ! -x "$CODEX_BIN" && ! -f "$CODEX_BIN" ]]; then
      fail "OpenAI Codex CLI installation failed in $NPM_GLOBAL_DIR"
      exit 1
    fi
    if ! "$CODEX_BIN" app-server --help &>/dev/null; then
      fail "OpenAI Codex CLI installed, but 'codex app-server' is unavailable."
      exit 1
    fi
    ok "Managed OpenAI Codex CLI installed ($("$CODEX_BIN" --version 2>/dev/null))"
  fi
fi

# ══════════════════════════════════════════════
#  Phase 5: OpenAI Codex Authentication
# ══════════════════════════════════════════════

phase "Phase 5: OpenAI Codex Authentication"

if [[ "$INSTALL_CODEX" != "true" ]]; then
  ok "Skipped (Codex not selected)"
else
  CODEX_AUTH_FILE="$HOME/.codex/auth.json"
  if codex login status &>/dev/null || [[ -f "$CODEX_AUTH_FILE" ]]; then
    ok "OpenAI Codex credentials found"
  elif [[ "$SKIP_CODEX_LOGIN" == "true" || "$NON_INTERACTIVE" == "true" ]]; then
    warn "OpenAI Codex is not authenticated. Skipping interactive login."
    echo "  Run 'codex login --device-auth' later if this server should run Codex sessions."
  else
    warn "OpenAI Codex is not authenticated."
    echo "  Running 'codex login --device-auth'."
    echo "  Scan this QR code with your phone, or open the link on this PC:"
    echo "  $CODEX_DEVICE_URL"
    echo ""
    install_server_dependencies_and_build
    render_qr "$CODEX_DEVICE_URL"
    echo ""
    echo "  The Codex CLI will print a one-time code. Enter that code on the page."
    echo "  Complete the login, then return to this terminal."
    echo ""
    prompt_read "  Press Enter to start login..." _
    codex login --device-auth || true

    if codex login status &>/dev/null || [[ -f "$CODEX_AUTH_FILE" ]]; then
      ok "Codex authentication successful"
    else
      warn "Could not verify Codex authentication. Codex sessions will be hidden until you run 'codex login'."
    fi
  fi
fi

# ══════════════════════════════════════════════
#  Phase 6: Install Dependencies & Build
# ══════════════════════════════════════════════

phase "Phase 6: Install Dependencies & Build"

install_server_dependencies_and_build

# ══════════════════════════════════════════════
#  Phase 7: Generate Configuration
# ══════════════════════════════════════════════

phase "Phase 7: Generate Configuration"

if [[ "$RESET_PAIRING" == "true" ]]; then
  warn "Resetting pairing data..."
  rm -f "$KEYS_FILE"
  if [[ -f "$ENV_FILE" ]]; then
    sed '/^PAIRING_TOKEN=/d' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
fi

IS_UPGRADE=false
[[ -f "$ENV_FILE" ]] && IS_UPGRADE=true

# Ensure data directory exists for keys file
canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

if [[ -d "$LEGACY_DATA_DIR" && "$DATA_DIR" != "$LEGACY_DATA_DIR" ]]; then
  if [[ -e "$DATA_DIR" && "$(canonical_dir "$DATA_DIR")" == "$(canonical_dir "$LEGACY_DATA_DIR")" ]]; then
    :
  elif [[ ! -e "$DATA_DIR" ]]; then
    mv "$LEGACY_DATA_DIR" "$DATA_DIR"
    ln -s "$DATA_DIR" "$LEGACY_DATA_DIR" 2>/dev/null || true
    ok "Migrated SocketAgent data to $DATA_DIR"
  else
    cp -R -n "$LEGACY_DATA_DIR"/. "$DATA_DIR"/ 2>/dev/null || true
    ok "Merged legacy SocketAgent data into $DATA_DIR"
  fi
fi
mkdir -p "$DATA_DIR"

# Run from server dir so require('tweetnacl') resolves
SETUP_OUTPUT=$(cd "$SERVER_DIR" && node "$SETUP_SCRIPT" \
  --envfile "$ENV_FILE" \
  --keysfile "$KEYS_FILE" \
  --relay-url "$RELAY_URL" \
  --default-cwd "$HOME" \
  --port "$PORT")

# QR payload is the last line
QR_PAYLOAD=$(echo "$SETUP_OUTPUT" | tail -1)

# Print non-QR output
printf '%s\n' "$SETUP_OUTPUT" | sed '$d' | while IFS= read -r line; do echo "    $line"; done

if [[ "$IS_UPGRADE" == "true" ]]; then
  ok "Configuration updated (existing tokens preserved)"
else
  ok "Configuration generated"
fi

# ══════════════════════════════════════════════
#  Phase 8: Register Service
# ══════════════════════════════════════════════

phase "Phase 8: Register Service"

NODE_PATH=$(command -v node)
NPM_PATH=$(command -v npm)
NPX_PATH=$(command -v npx)
SERVICE_CONTROL="$SERVER_DIR/scripts/service-control.sh"
chmod +x "$SERVER_DIR/scripts/start-server.sh" "$SERVER_DIR/scripts/restart-server.sh" \
  "$SERVER_DIR/scripts/recovery-guard.sh" "$SERVICE_CONTROL"

NODE_DIR=$(dirname "$NODE_PATH")
SERVICE_PATH="$NODE_DIR"
SERVICE_PATH="$SERVICE_PATH:$NPM_BIN_DIR"
SERVICE_PATH="$SERVICE_PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ "$OS_NAME" == "Darwin" ]]; then
  SERVICE_LABEL="com.socketagent.server"
  SERVICE_DIR="$HOME/Library/LaunchAgents"
  SERVICE_FILE="$SERVICE_DIR/$SERVICE_LABEL.plist"
  SERVICE_LOG="$SERVER_DIR/socketagent.log"
  GUI_DOMAIN="gui/$(id -u)"

  xml_escape() {
    printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
  }

  mkdir -p "$SERVICE_DIR"
  touch "$SERVICE_LOG"
  chmod 600 "$SERVICE_LOG"
  SERVER_DIR_XML="$(xml_escape "$SERVER_DIR")"
  START_SCRIPT_XML="$(xml_escape "$SERVER_DIR/scripts/start-server.sh")"
  HOME_XML="$(xml_escape "$HOME")"
  PATH_XML="$(xml_escape "$SERVICE_PATH")"
  NODE_XML="$(xml_escape "$NODE_PATH")"
  NPM_XML="$(xml_escape "$NPM_PATH")"
  NPX_XML="$(xml_escape "$NPX_PATH")"
  LOG_XML="$(xml_escape "$SERVICE_LOG")"

  cat > "$SERVICE_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$START_SCRIPT_XML</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SERVER_DIR_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME_XML</string>
    <key>PATH</key>
    <string>$PATH_XML</string>
    <key>SOCKETAGENT_NODE</key>
    <string>$NODE_XML</string>
    <key>SOCKETAGENT_NPM</key>
    <string>$NPM_XML</string>
    <key>SOCKETAGENT_NPX</key>
    <string>$NPX_XML</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_XML</string>
  <key>StandardErrorPath</key>
  <string>$LOG_XML</string>
</dict>
</plist>
EOF

  plutil -lint "$SERVICE_FILE" >/dev/null
  ok "Created $SERVICE_FILE"
  launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    if ! launchctl print "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  "$SERVICE_CONTROL" start
else
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=SocketAgent WebSocket Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
ExecStart=$SERVER_DIR/scripts/start-server.sh
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$SERVICE_PATH
Environment=SOCKETAGENT_NODE=$NODE_PATH
Environment=SOCKETAGENT_NPM=$NPM_PATH
Environment=SOCKETAGENT_NPX=$NPX_PATH
UnsetEnvironment=CLAUDECODE

[Install]
WantedBy=default.target
EOF

  ok "Created $SERVICE_FILE"

  # Enable linger so service runs without active login
  if command -v loginctl &>/dev/null; then
    loginctl enable-linger "$(whoami)" 2>/dev/null || true
  fi

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
fi

sleep 3

if "$SERVICE_CONTROL" is-active; then
  ok "Server is running on port $PORT"
else
  warn "Server may not have started. Check: socketagent status"
  warn "Logs: socketagent logs"
fi

# ══════════════════════════════════════════════
#  Phase 9: Install CLI
# ══════════════════════════════════════════════

phase "Phase 9: Install CLI"
install_cli

# ══════════════════════════════════════════════
#  Phase 10: QR Code & Summary
# ══════════════════════════════════════════════

phase "Phase 10: Phone Pairing"

echo ""
echo -e "  ${CYAN}Scan this QR code with the SocketAgent app:${NC}"
echo ""

# Generate QR using server's qrcode-terminal package
(cd "$SERVER_DIR" && node -e "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>{c.split('\n').forEach(l=>console.log('  '+l))})" "$QR_PAYLOAD" 2>/dev/null) || \
  warn "QR code rendering failed. Use manual pairing below."

echo ""
echo -e "  ${YELLOW}If QR scan doesn't work, paste this in the app:${NC}"
echo -e "  ${NC}$QR_PAYLOAD"
echo ""

# ── Success ──
echo ""
echo -e "  ${GREEN}===========================================${NC}"
echo -e "  ${GREEN} Installation complete!${NC}"
echo -e "  ${GREEN}===========================================${NC}"
echo ""
if [[ "$OS_NAME" == "Darwin" ]]; then
  echo "  The server starts automatically when this macOS user logs in."
else
  echo "  The server starts automatically on boot."
fi
echo ""
echo -e "  ${CYAN}Management commands:${NC}"
echo "    CLI:       socketagent help"
echo "    Status:    socketagent status"
echo "    Start:     socketagent start"
echo "    Stop:      socketagent stop"
echo "    Logs:      socketagent logs"
echo "    Restart:   socketagent restart"
echo ""
echo "  To update, run: git pull && bash install-server.sh"
echo "  Existing pairings are preserved."
echo ""
