# SocketAgent

Access Claude Code and OpenAI Codex agents on your computers from your Android phone or Windows desktop. Install the free SocketAgent server software on the computers you want to connect to, then pair them with the app.

## Download SocketAgent Desktop for Windows

[Download SocketAgent Desktop for Windows](https://github.com/Yllib/socketagent/releases/download/windows-v1.0.253/SocketAgent-Desktop-Setup.exe)

Run the installer on Windows 10 or 11, 64-bit. Setup detects an existing local
SocketAgent server and links to it automatically. If there is no local server,
setup offers to install one.

A local server is optional. You can add other computers via their pairing codes
without installing a server on this computer. You can also import the computer
transfer QR code exported by the Android app.

SocketAgent Desktop includes a resizable session sidebar, system tray support,
saved window size and position, and desktop menus. Press Enter to send a message
or Shift+Enter for a new line. Closing the window keeps the app in the tray;
choose Quit from the tray menu to exit.

## Download the Android App

Download the latest APK:

[Download SocketAgent for Android](https://github.com/Yllib/socketagent/releases/latest/download/app-release.apk)

## Install the Server

Install the server on the computer you want SocketAgent to control. The Windows
desktop installer above can do this for you, or you can install only the server
using the commands below.

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

Windows setup offers a destination folder on a first install and reuses the existing
folder on subsequent runs. It installs SocketAgent plus
both supported agent CLIs, starts SocketAgent, and then shows the pairing QR
code. Sign in to Claude or Codex later from the app or the relevant CLI.

For a custom Windows destination without prompts:

```powershell
$env:SOCKETAGENT_INSTALL_DIR = 'D:\Apps\SocketAgent'
$env:SOCKETAGENT_UNATTENDED = '1'
irm https://raw.githubusercontent.com/Yllib/socketagent/master/install-windows.ps1 | iex
```

Windows stores server files in the selected folder, managed Claude/Codex tools in
`%USERPROFILE%\.socket-agent\toolchains\npm-global`, and session data in
`%USERPROFILE%\.socket-agent`. Existing legacy data is preserved. The launcher
and command shortcuts live under `%LOCALAPPDATA%\SocketAgent`. Setup prints the
actual locations, including any configured overrides.

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

## Notifications

Relay-connected phones use SocketAgent's Firebase project and need no Firebase
setup of their own. Open the computer in the app, choose **Notifications**, grant
Android notification permission, and enroll the phone.

A phone that connects only over the local network needs a Firebase project so
the computer can deliver notifications while the app is closed:

1. Create or open a project in the [Firebase console](https://console.firebase.google.com/).
2. Add an Android app with the package name `com.socketagent.app`. The app
   nickname can be anything. A signing certificate is not required for push
   notifications.
3. Download `google-services.json` to the phone.
4. In SocketAgent, open the computer, choose **Notifications**, then choose
   **Manage Firebase** and **Import JSON**. Close and reopen SocketAgent when it
   asks.
5. In the Firebase console, open **Project settings**, then **Service accounts**.
   Generate a private key for the Firebase Admin SDK and save that JSON file on
   the computer. Do not put this private file on the phone or commit it to Git.
6. Add its absolute path to `server/.env` in the SocketAgent checkout:

   ```env
   FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/service-account.json
   ```

7. Run `socketagent restart`, reconnect the app, and enroll the phone under
   **Notifications**.

The phone's `google-services.json` and the computer's service-account JSON must
come from the same Firebase project. The app reports missing permission,
missing registration, unreadable credentials, and project mismatches in the
Notifications section.

## Requirements

- Android phone or Windows 10/11 desktop, 64-bit
- Windows, macOS, Linux, or WSL computer
- Claude Code account if you want Claude sessions
- ChatGPT/Codex account if you want Codex sessions

## Notes

- The server must run from a git checkout. Do not install from a downloaded ZIP.
- Re-running the installer is safe. It keeps existing pairing and auth data.
- Installed servers auto-update when no sessions are active.
- Auto-update replaces tracked files in the installed checkout. Keep your projects
  outside that folder, or set `SOCKETAGENT_AUTO_UPDATE=0` to manage updates yourself.
- Local data is stored under `~/.socket-agent/`; existing `~/.claude-assistant/` data is preserved during migration.

## Troubleshooting

**The app cannot connect after install**

Run:

```bash
socketagent status
socketagent pair
```

Then scan the new QR code.

**A blank window opens at Windows login**

SocketAgent runs in the background after you sign in to Windows. Updated servers
repair older startup tasks for their next start. If Windows protects the old task,
the window may flash briefly before hiding. Open PowerShell with **Run as administrator**
and rerun setup to replace that task and remove the flash.
Use `socketagent status` to check readiness and `socketagent logs`
to view server output.

**Windows says scripts are blocked**

The Windows bootstrap applies an execution-policy bypass only to its installer
process. Managed Claude and Codex commands use `.cmd` launchers and work in fresh
PowerShell terminals without changing your account's execution policy. If an
older installation reports a blocked `claude.ps1` or `codex.ps1`, rerun setup and
open a new terminal. Organization policy can still restrict installation.

**The QR code disappeared**

Run:

```bash
socketagent pair
```

**The app says a backend is not ready**

Open the server in SocketAgent settings and use the repair or sign-in action for Claude or Codex.

## License

Server: MIT
