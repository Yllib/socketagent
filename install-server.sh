#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════
#  SocketAgent Linux Server Installer
# ══════════════════════════════════════════════
#
# Installs everything needed to run SocketAgent server on Linux:
# Node.js, Claude Code CLI, OpenAI Codex CLI, server dependencies,
# configuration, and systemd user service.
#
# Usage:
#   bash install-server.sh [--reset-pairing] [--port PORT] [--backends claude|codex|both]
#
# Re-running is safe — existing tokens and pairings are preserved.

RELAY_URL="wss://relay.jarofdirt.info"
SERVICE_NAME="socketagent"
NODE_MIN_VERSION=22
PORT=8085
RESET_PAIRING=false
BACKENDS=""
ENABLED_BACKENDS=""
INSTALL_CLAUDE=false
INSTALL_CODEX=false

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --reset-pairing) RESET_PAIRING=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --backend|--backends) BACKENDS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Paths
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$REPO_ROOT/server"
ENV_FILE="$SERVER_DIR/.env"
DATA_DIR="$HOME/.claude-assistant"
KEYS_FILE="$DATA_DIR/relay-keys.json"
SETUP_SCRIPT="$SERVER_DIR/scripts/setup.js"

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

select_backends() {
  local value
  value=$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')

  if [[ -z "$value" ]]; then
    phase "Backend Selection"
    echo "  Which agent backend(s) should this server use?"
    echo "    1) Codex only"
    echo "    2) Claude only"
    echo "    3) Both Claude and Codex"
    echo ""
    read -rp "  Choose [3]: " value
    value=$(echo "${value:-3}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  fi

  case "$value" in
    1|codex|openai)
      ENABLED_BACKENDS="codex"
      ;;
    2|claude|anthropic)
      ENABLED_BACKENDS="claude"
      ;;
    3|both|all|claude,codex|codex,claude)
      ENABLED_BACKENDS="claude,codex"
      ;;
    *)
      fail "Invalid backend selection: ${1:-$value}. Use claude, codex, or both."
      exit 1
      ;;
  esac

  if [[ ",$ENABLED_BACKENDS," == *",claude,"* ]]; then INSTALL_CLAUDE=true; fi
  if [[ ",$ENABLED_BACKENDS," == *",codex,"* ]]; then INSTALL_CODEX=true; fi
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
      if [[ -n "${SHELL:-}" && "$(basename "$SHELL")" == "bash" ]]; then
        shell_rc="$HOME/.bashrc"
      fi
      if [[ -f "$shell_rc" ]] && ! grep -q 'HOME/.local/bin' "$shell_rc"; then
        printf '\n# SocketAgent CLI\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$shell_rc"
        ok "Added ~/.local/bin to PATH in $shell_rc"
      else
        warn "Add this to your shell profile if needed: export PATH=\"\$HOME/.local/bin:\$PATH\""
      fi
      ;;
  esac
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
ok "Selected backends: $ENABLED_BACKENDS"

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
  # Install Node.js from official binary tarball — works on any Linux distro
  # regardless of broken apt repos, pinning, or package manager quirks
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    armv7l)  NODE_ARCH="armv7l" ;;
    *) fail "Unsupported architecture: $ARCH"; exit 1 ;;
  esac

  NODE_INSTALL_DIR="/usr/local"
  NODE_TARBALL="node-v22.22.1-linux-${NODE_ARCH}.tar.xz"
  NODE_URL="https://nodejs.org/dist/v22.22.1/${NODE_TARBALL}"

  echo "  Downloading Node.js v22.22.1 for ${NODE_ARCH}..."
  curl -fSL --progress-bar -o "/tmp/${NODE_TARBALL}" "$NODE_URL"

  echo "  Installing to ${NODE_INSTALL_DIR}..."
  sudo tar -xJf "/tmp/${NODE_TARBALL}" -C "$NODE_INSTALL_DIR" --strip-components=1
  rm -f "/tmp/${NODE_TARBALL}"

  # Refresh PATH
  hash -r 2>/dev/null
  export PATH="/usr/local/bin:$PATH"

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

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

phase "Phase 2: Claude Code CLI"

if [[ "$INSTALL_CLAUDE" != "true" ]]; then
  ok "Skipped (Claude not selected)"
else
  if command -v claude &>/dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null || echo "unknown")
    ok "Claude Code CLI already installed ($CLAUDE_VER)"
  else
    echo "  Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
    if ! command -v claude &>/dev/null; then
      fail "Claude Code CLI installation failed. Try: npm install -g @anthropic-ai/claude-code"
      exit 1
    fi
    ok "Claude Code CLI installed ($(claude --version 2>/dev/null))"
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
  else
    warn "Claude Code is not authenticated."
    echo "  Running 'claude login' -- this will open your browser."
    echo "  Complete the login, then return to this terminal."
    echo ""
    read -rp "  Press Enter to start login..."
    claude login

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
  if command -v codex &>/dev/null; then
    CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
    if codex app-server --help &>/dev/null; then
      ok "OpenAI Codex CLI already installed ($CODEX_VER)"
    else
      warn "OpenAI Codex CLI found ($CODEX_VER) but app-server is unavailable. Updating..."
      NEED_CODEX_INSTALL=true
    fi
  else
    echo "  Installing OpenAI Codex CLI..."
    NEED_CODEX_INSTALL=true
  fi

  if [[ "$NEED_CODEX_INSTALL" == "true" ]]; then
    npm install -g @openai/codex
    hash -r 2>/dev/null
    if ! command -v codex &>/dev/null; then
      fail "OpenAI Codex CLI installation failed. Try: npm install -g @openai/codex"
      exit 1
    fi
    if ! codex app-server --help &>/dev/null; then
      fail "OpenAI Codex CLI installed, but 'codex app-server' is unavailable. Try: npm install -g @openai/codex@latest"
      exit 1
    fi
    ok "OpenAI Codex CLI installed ($(codex --version 2>/dev/null))"
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
  else
    warn "OpenAI Codex is not authenticated."
    echo "  Running 'codex login' -- this will open your browser or show a device login."
    echo "  Complete the login, then return to this terminal."
    echo ""
    read -rp "  Press Enter to start login..."
    codex login || true

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

echo "  Running npm install..."
(cd "$SERVER_DIR" && npm install)
ok "Dependencies installed"

echo "  Compiling TypeScript..."
(cd "$SERVER_DIR" && npx tsc)
ok "Server built successfully"

# ══════════════════════════════════════════════
#  Phase 7: Generate Configuration
# ══════════════════════════════════════════════

phase "Phase 7: Generate Configuration"

if [[ "$RESET_PAIRING" == "true" ]]; then
  warn "Resetting pairing data..."
  rm -f "$KEYS_FILE"
  if [[ -f "$ENV_FILE" ]]; then
    sed -i '/^PAIRING_TOKEN=/d' "$ENV_FILE"
  fi
fi

IS_UPGRADE=false
[[ -f "$ENV_FILE" ]] && IS_UPGRADE=true

# Ensure data directory exists for keys file
mkdir -p "$DATA_DIR"

# Run from server dir so require('tweetnacl') resolves
SETUP_OUTPUT=$(cd "$SERVER_DIR" && node "$SETUP_SCRIPT" \
  --envfile "$ENV_FILE" \
  --keysfile "$KEYS_FILE" \
  --relay-url "$RELAY_URL" \
  --default-cwd "$HOME" \
  --port "$PORT" \
  --enabled-backends "$ENABLED_BACKENDS")

# QR payload is the last line
QR_PAYLOAD=$(echo "$SETUP_OUTPUT" | tail -1)

# Print non-QR output
echo "$SETUP_OUTPUT" | head -n -1 | while read -r line; do echo "    $line"; done

if [[ "$IS_UPGRADE" == "true" ]]; then
  ok "Configuration updated (existing tokens preserved)"
else
  ok "Configuration generated"
fi

# ══════════════════════════════════════════════
#  Phase 8: Register systemd Service
# ══════════════════════════════════════════════

phase "Phase 8: Register systemd Service"

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
NODE_PATH=$(command -v node)

mkdir -p "$SERVICE_DIR"

NODE_DIR=$(dirname "$NODE_PATH")
SERVICE_PATH="$NODE_DIR"
if command -v claude &>/dev/null; then
  SERVICE_PATH="$SERVICE_PATH:$(dirname "$(command -v claude)")"
fi
if command -v codex &>/dev/null; then
  SERVICE_PATH="$SERVICE_PATH:$(dirname "$(command -v codex)")"
fi
SERVICE_PATH="$SERVICE_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=SocketAgent WebSocket Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_PATH $SERVER_DIR/dist/index.js
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$SERVICE_PATH
UnsetEnvironment=CLAUDECODE

[Install]
WantedBy=default.target
EOF

ok "Created $SERVICE_FILE"

# Enable linger so service runs without active login
if command -v loginctl &>/dev/null; then
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

# Reload, enable, and start
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

# Stop if already running, then start fresh
systemctl --user restart "$SERVICE_NAME"
sleep 3

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  ok "Server is running on port $PORT"
else
  warn "Server may not have started. Check: systemctl --user status $SERVICE_NAME"
  warn "Logs: journalctl --user -u $SERVICE_NAME -f"
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
echo "  The server starts automatically on boot."
echo ""
echo -e "  ${CYAN}Management commands:${NC}"
echo "    CLI:       socketagent help"
echo "    Status:    systemctl --user status $SERVICE_NAME"
echo "    Start:     systemctl --user start $SERVICE_NAME"
echo "    Stop:      systemctl --user stop $SERVICE_NAME"
echo "    Logs:      journalctl --user -u $SERVICE_NAME -f"
echo "    Restart:   systemctl --user restart $SERVICE_NAME"
echo ""
echo "  To update, run: git pull && bash install-server.sh"
echo "  Existing pairings are preserved."
echo ""
