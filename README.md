# SocketAgent

Access Claude Code and OpenAI Codex agents on your computers from your Android phone or Windows desktop. Install the free SocketAgent server software on the computers you want to connect to, then pair them with the app.

## Get the app

- Windows desktop: [SocketAgent Desktop installer](https://rubanoenterprises.com/socketagent_desktop_installer.exe)
- Android: [Google Play](https://play.google.com/store/apps/details?id=com.socketagent.app) or the [APK](https://github.com/Yllib/socketagent/releases/latest/download/app-release.apk)

The desktop installer can also install the server on the same PC.

## Install the server

Install the server on each computer you want to reach from the app.

### Windows

Download the [SocketAgent Server installer](https://rubanoenterprises.com/socketagent_server_installer.exe),
or run this script in PowerShell. Both do the same thing. Run the script from
an administrator PowerShell for full features.

```powershell
irm https://raw.githubusercontent.com/Yllib/socketagent/master/install-windows.ps1 | iex
```

### macOS, Linux, or WSL

```bash
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
```

## Pair the app

At the end of setup, the installer shows a QR code.

1. Open SocketAgent on your phone.
2. Scan the QR code.
3. Start a session from the app.

If you missed the QR code, run this on the server computer:

```bash
socketagent pair
```

The phone connects directly when it is on the computer's network and through
the relay everywhere else, switching as you move. The server advertises itself
over mDNS (`_socketagent._tcp`), so a changed LAN address is found again. To pin
one route, edit the computer in the app and pick Relay or Direct.

## What gets installed

The installer sets up:

- Git if needed
- Node.js if needed
- The SocketAgent server
- The Claude Code and Codex CLIs
- A background service so SocketAgent starts automatically
- A `socketagent` command for pairing, reinstalling, logs, and status

## Useful commands

Run these on the server computer:

```bash
socketagent pair      # show a new pairing QR code
socketagent direct    # same QR plus the address, port, token and key to enter by hand
socketagent status    # check server status
socketagent logs      # view server logs
socketagent doctor    # run basic diagnostics
socketagent restart   # restart the server safely
socketagent install   # re-run the installer, keeping pairing and auth data
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
and rerun setup, or run the server installer again, to replace that task and
remove the flash.
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

Open the computer in SocketAgent settings and use **Reinstall** or the sign-in
action for Claude or Codex.

## License

Server: MIT
