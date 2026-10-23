#Requires -Version 5.1
<#
.SYNOPSIS
    SocketAgent Windows Uninstaller
.DESCRIPTION
    Stops and removes the SocketAgent scheduled tasks.
    Optionally removes session data.
    Does NOT uninstall Node.js, Claude Code CLI, or OpenAI Codex CLI.
#>

$ErrorActionPreference = "Stop"
# The SYSTEM task first, so it cannot take over once the owner's task stops.
$TASK_NAMES = @("SocketAgentService", "SocketAgent", "SocketAgentRecovery")

Write-Host ""
Write-Host "  SocketAgent Uninstaller" -ForegroundColor Cyan
Write-Host ""

# Stop and remove scheduled tasks
$removed = 0
foreach ($taskName in $TASK_NAMES) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    if ($task.State -eq "Running") {
        Write-Host "  Stopping $taskName..."
        Stop-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 2
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "  [OK] Removed scheduled task '$taskName'" -ForegroundColor Green
    $removed++
}
if ($removed -eq 0) {
    Write-Host "  No scheduled task found." -ForegroundColor Yellow
}
Remove-Item -LiteralPath (Join-Path $env:ProgramData "SocketAgent\machine-server.json") -Force -ErrorAction SilentlyContinue

# Remove log file
$logFile = Join-Path $PSScriptRoot "server" "socketagent.log"
if (Test-Path $logFile) {
    Remove-Item $logFile -Force
    Write-Host "  [OK] Removed log file" -ForegroundColor Green
}

# Ask about data removal
Write-Host ""
$removeData = Read-Host "  Remove session data (~\.socketagent)? (y/N)"
if ($removeData -eq "y") {
    $dataDir = Join-Path $env:USERPROFILE ".socketagent"
    if (Test-Path $dataDir) {
        Remove-Item $dataDir -Recurse -Force
        Write-Host "  [OK] Removed $dataDir" -ForegroundColor Green
    }
}

# Ask about .env removal
$removeEnv = Read-Host "  Remove server config (server\.env)? (y/N)"
if ($removeEnv -eq "y") {
    $envFile = Join-Path $PSScriptRoot "server" ".env"
    if (Test-Path $envFile) {
        Remove-Item $envFile -Force
        Write-Host "  [OK] Removed .env" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "  Uninstall complete." -ForegroundColor Green
Write-Host "  Node.js, Claude Code CLI, and OpenAI Codex CLI were NOT removed." -ForegroundColor Yellow
Write-Host ""
