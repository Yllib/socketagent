# SocketAgent Git Checkout Repair

## Problem

SocketAgent says:

`This server was not installed from a git checkout, so in-app updates are unavailable.`

That means the SocketAgent server is running from a copied/extracted folder that does not contain a `.git` checkout. The server can still run, but server self-updates cannot work because SocketAgent updates itself with `git fetch`, `git reset`, dependency install, and rebuild.

This usually happens on Windows when `install.ps1` was run from a downloaded ZIP or copied folder instead of a real `git clone`.

## Confirm

Open PowerShell and run:

```powershell
socketagent doctor
```

Copy the `Repo:` path, then check it:

```powershell
cd "PASTE_REPO_PATH_FROM_DOCTOR"
git status
```

If Git says it is not a repository, repair the install.

## Repair On Windows

Run this in PowerShell. Replace the `$old` value with the `Repo:` path from `socketagent doctor`.

```powershell
$old = "PASTE_REPO_PATH_FROM_SOCKETAGENT_DOCTOR"
$new = "$env:LOCALAPPDATA\SocketAgent\socketagent-repo"

git clone https://github.com/Yllib/socketagent.git $new

# Preserve existing server config/direct auth token if present.
if (Test-Path "$old\server\.env") {
  Copy-Item "$old\server\.env" "$new\server\.env" -Force
}

powershell -ExecutionPolicy Bypass -File "$new\install.ps1" -Backends installed -NonInteractive -SkipClaudeLogin -SkipCodexLogin
```

The installer will remove and recreate the `SocketAgent` Scheduled Task so it runs from the git checkout.

`-Backends installed` enables whichever supported CLIs are already installed on that machine. Use `-Backends both -NonInteractive -SkipClaudeLogin -SkipCodexLogin` instead if this server should install/repair both Claude and Codex without blocking for login.

## After Repair

Verify:

```powershell
socketagent doctor
cd "$env:LOCALAPPDATA\SocketAgent\socketagent-repo"
git status
```

In the Android app, open server settings and run the server update check again. It should now show git version details instead of the git checkout warning.

## Notes

- Relay keys are stored in `%USERPROFILE%\.claude-assistant`, so relay pairing should usually survive.
- `server\.env` stores server config and the direct auth token. Copying it avoids breaking existing direct/manual connections.
- If `.env` was missing or not copied, re-pair the server or update the server entry in the app.
