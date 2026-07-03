# SocketAgent

Use Claude Code or OpenAI Codex from your Android phone. SocketAgent pairs a mobile chat app with a small server on your own machine, so you can start coding sessions, stream tool output, send files, speak responses aloud, schedule work, resume old sessions, and keep working while away from the keyboard.

## What This Repo Contains

- `server/` - Node.js + TypeScript WebSocket server. It owns pairing, sessions, backend orchestration, MCP/app tools, history, scheduled tasks, and relay connectivity.
- `install.sh` - Linux/WSL installer for Node.js, selected agent CLIs, server config, and a `systemd --user` service.
- `install.ps1` - Windows installer for Node.js, selected agent CLIs, server config, and a scheduled task.
- `app-version.json` - Published Android app version metadata.
- Android app - APK releases are published from this repo for normal installs. The Flutter app source is not included in this public server repo.

## Architecture

```text
Android App
   |
   | WebSocket JSON, NaCl E2E encryption
   v
Relay Server, optional for remote access
   |
   | WebSocket JSON, NaCl E2E encryption
   v
SocketAgent Server
   |\
   | \-- Claude backend: Claude Agent SDK / Claude Code auth
   |
    \--- Codex backend: OpenAI Codex CLI app-server by default, exec fallback
```

The relay forwards NaCl-encrypted traffic and cannot read your chat or tool output. Local/direct connections bypass the relay when your phone can reach the server. If the app has the server public key from pairing/config import, direct mode uses the same NaCl E2E envelope and sends the auth token only inside that encrypted channel. Legacy direct connections without a saved server public key still use bearer-token WebSocket auth for compatibility and should stay on trusted LAN/VPN only.

## Agent Backends

SocketAgent supports both Claude and Codex on every managed server. The installer can install or repair one or both managed toolchains during setup; runtime availability is shown as backend health/auth state in the app.

| Backend | Runtime | Notes |
| --- | --- | --- |
| Claude | Claude Agent SDK with Claude Code auth | Full SocketAgent feature set, including Claude-specific session controls such as fork/rewind. |
| Codex | OpenAI Codex CLI, app-server by default | Supports live event cards, app tools, steering/injected messages, resume/archive/clear, and scheduled tasks. Some Claude-specific features, such as per-message rewind, are not available. |

Both backends are advertised to the app. If a toolchain is missing, unhealthy, or not signed in, the app shows repair/sign-in actions instead of hiding that backend.

## Install

Install the Android APK from the latest GitHub release, then install the server on the machine you want the agent to control.

Latest APK:

```text
https://github.com/Yllib/socketagent/releases/latest/download/app-release.apk
```

Quick start:

1. Install the APK on your Android phone.
2. Clone this repo on the computer you want to control.
3. Run the installer for your OS.
4. Choose Claude, Codex, or both when prompted.
5. Sign in to the selected agent CLI when prompted.
6. Scan the QR code printed by the installer.

If you miss the QR code or want to pair another phone later, run:

```bash
socketagent pair
```

Requirements:

- Android phone for the app.
- Linux, WSL, or Windows machine for the server.
- Git on the server machine. SocketAgent servers must run from a git checkout; zip/archive installs are rejected.
- A Claude Code account if using Claude.
- A ChatGPT/Codex account if using Codex.

### Linux

One-line install:

```bash
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
```

One-line install with a preset backend:

```bash
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash -s -- --backends codex
```

Interactive install:

```bash
git clone https://github.com/Yllib/socketagent.git
cd socketagent
bash install.sh
```

Noninteractive managed toolchain selection:

```bash
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash -s -- --backends both
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash -s -- --backends codex
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash -s -- --backends claude
```

### Windows

Install Git first if `git` is not already available in PowerShell.

One-line install:

```powershell
powershell -ExecutionPolicy Bypass -Command "git clone https://github.com/Yllib/socketagent.git; cd socketagent; .\install.ps1"
```

Interactive install:

```powershell
git clone https://github.com/Yllib/socketagent.git
cd socketagent
powershell -ExecutionPolicy Bypass -File install.ps1
```

Noninteractive managed toolchain selection:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Backends both
powershell -ExecutionPolicy Bypass -File install.ps1 -Backends codex
powershell -ExecutionPolicy Bypass -File install.ps1 -Backends claude
```

The installer handles:

- Node.js 22+
- Claude Code CLI when Claude is selected
- OpenAI Codex CLI when Codex is selected
- Agent authentication prompts
- Server dependencies and TypeScript build
- Pairing token and encryption key generation
- Linux `systemd --user` service or Windows scheduled task registration
- QR code pairing for the Android app

Re-running the installer is safe. Existing pairing keys and auth tokens are preserved unless you pass the reset option.
The installer also registers a `socketagent` command on PATH. `socketclaude` is installed as an alias.

## Pairing

At the end of install, the server prints a QR code and a fallback pairing string.

1. Open the SocketAgent Android app.
2. Add or pair a server.
3. Scan the QR code, or paste the pairing string.
4. Choose the backend for new sessions if your server advertises more than one.

## Features

- Claude and Codex sessions from the same app
- Streaming markdown chat
- Live tool output cards
- File upload and download
- Voice input and text-to-speech output
- Message steering/injection while an agent is working
- Stop/interrupt controls
- Session resume, archive, restore, and clear context
- Scheduled one-time and recurring tasks
- Todo, reminder, and SendFile app tools exposed to agents
- Token/context usage display where the backend exposes it
- Auto-reconnect and missed message recovery
- Git-based server auto-update when idle
- Private server plugin API

## Management

### CLI

```bash
socketagent pair
socketagent install --backends both
socketagent status
socketagent logs
socketagent restart
socketagent doctor
```

### Linux

```bash
systemctl --user status socketagent
systemctl --user start socketagent
systemctl --user stop socketagent
journalctl --user -u socketagent -f
```

### Windows

```powershell
Get-ScheduledTask -TaskName SocketAgent
Start-ScheduledTask -TaskName SocketAgent
Stop-ScheduledTask -TaskName SocketAgent
Get-Content server\socketagent.log -Tail 50
```

To update the server manually:

```bash
git pull && bash install.sh
```

```powershell
git pull; powershell -ExecutionPolicy Bypass -File install.ps1
```

Installed servers also auto-update from git when no sessions are active.

## Configuration

Primary server config lives in `server/.env`.

Common values:

- `PORT` - WebSocket/API port, default `8085`.
- `BIND_HOST` - interface for the direct HTTP/WebSocket server, default `127.0.0.1`. Set `0.0.0.0` only when you intentionally want LAN direct mode.
- `AUTH_TOKEN` - app/server auth secret generated by setup.
- `DEFAULT_CWD` - default working directory for new sessions.
- `RELAY_URL` - relay endpoint.
- `PAIRING_TOKEN` - token encoded in the pairing QR.
- `SOCKETAGENT_AUTO_UPDATE` - set to `0`/`false`/`off` to disable git auto-update.
- `SOCKETAGENT_AUTO_UPDATE_VERIFY` - defaults to `commit`, requiring `git verify-commit` against `.github/allowed_signers` before auto-update applies a fetched commit. Set to `none` to disable signature enforcement.
- `SOCKETAGENT_AUTO_UPDATE_REQUIRE_SIGNED_COMMITS` - set to `0`/`false`/`off` as an alias for disabling signed-commit update enforcement.
- `SOCKETAGENT_SHOW_PAIRING_QR_ON_STARTUP` - set to `1` only for an explicit pairing session; otherwise startup logs redact pairing secrets.

Runtime data is stored under `~/.claude-assistant/`, including session metadata, chat history, scheduled tasks, relay keys, recent working directories, and local app/server state. SocketAgent intentionally keeps this legacy path so upgrades preserve existing pairings and history.

## Plugins

Server plugins are private `.js` modules loaded from `server/plugins/`. They can provide extra tools, MCP servers, and context for sessions.

See [server/plugins/README.md](server/plugins/README.md).

## License

Server: MIT
