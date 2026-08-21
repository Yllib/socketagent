# SocketAgent

Use Claude Code or OpenAI Codex from your Android phone. Install the Android app, install the SocketAgent server on your computer, then pair them with a QR code.

## Download the Android App

Download the latest APK:

[Download SocketAgent for Android](https://github.com/Yllib/socketagent/releases/latest/download/app-release.apk)

## Install the Server

Install the server on the computer you want SocketAgent to control.

### Windows

Open PowerShell and paste this command:

```powershell
irm https://raw.githubusercontent.com/Yllib/socketagent/master/install-windows.ps1 | iex
```

### macOS, Linux, or WSL

Open a terminal and paste this command:

```bash
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
```

The installer needs no choices or sign-in prompts. It installs SocketAgent plus
both supported agent CLIs, starts SocketAgent, and then shows the pairing QR
code. Sign in to Claude or Codex later from the app or the relevant CLI.

## Pair the App

At the end of setup, the installer shows a QR code.

1. Open SocketAgent on your phone.
2. Scan the QR code.
3. Start a session from the app.

If you missed the QR code, run this on the server computer:

```bash
socketagent pair
```

## What Gets Installed

The installer sets up:

- Git if needed
- Node.js if needed
- The SocketAgent server
- Claude and Codex support
- A background service so SocketAgent starts automatically
- A `socketagent` command for pairing, repair, logs, and status

## Useful Commands

Run these on the server computer:

```bash
socketagent pair      # show a new pairing QR code
socketagent status    # check server status
socketagent logs      # view server logs
socketagent doctor    # run basic diagnostics
socketagent restart   # restart the server safely
```

## Requirements

- Android phone
- Windows, macOS, Linux, or WSL computer
- Claude Code account if you want Claude sessions
- ChatGPT/Codex account if you want Codex sessions

## Notes

- The server must run from a git checkout. Do not install from a downloaded ZIP.
- Re-running the installer is safe. It keeps existing pairing and auth data.
- Installed servers auto-update when no sessions are active.
- Local data is stored under `~/.claude-assistant/` so existing installs keep their history and pairing.

## Troubleshooting

**The app cannot connect after install**

Run:

```bash
socketagent status
socketagent pair
```

Then scan the new QR code.

**Windows says scripts are blocked**

Run the PowerShell command from this README exactly as written. It includes `-ExecutionPolicy Bypass` for the installer run.

**The QR code disappeared**

Run:

```bash
socketagent pair
```

**The app says a backend is not ready**

Open the server in SocketAgent settings and use the repair or sign-in action for Claude or Codex.

## License

Server: MIT
