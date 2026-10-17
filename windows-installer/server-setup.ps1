#Requires -Version 5.1
# Runs the SocketAgent server installer's steps for the Inno Setup wizard.
#   Detect     writes the existing server folder, if any, to -ResultFile
#   Install    installs or updates the server, then draws its pairing QR
#   Uninstall  stops the server and removes what setup registered
# Progress reaches the wizard as PHASE: lines, install output as LOG: lines and
# failures as one ERROR: line. Pairing tokens never reach the wizard or its log.
param(
    [ValidateSet('Detect', 'Install', 'Uninstall')][string]$Action = 'Detect',
    [string]$InstallDirectory,
    [string]$ResultFile,
    [string]$QrImage,
    [int]$QrPixels = 240
)
$ErrorActionPreference = 'Stop'
$script:firstFailure = ''
$bootstrap = Join-Path $PSScriptRoot 'server-bootstrap.ps1'

function Find-Server {
    $env:SOCKETAGENT_FIND_INSTALL = '1'
    try { return (& $bootstrap | Select-Object -Last 1) }
    finally { Remove-Item Env:SOCKETAGENT_FIND_INSTALL }
}

function Write-Result([string]$Directory) {
    if (!$ResultFile) { return }
    [IO.File]::WriteAllLines($ResultFile, @('[server]', "directory=$Directory"), [Text.Encoding]::Unicode)
}

try {
    if ($Action -eq 'Detect') {
        Write-Result (Find-Server)
        exit 0
    }

    if ($Action -eq 'Uninstall') {
        foreach ($name in @('SocketAgent', 'SocketClaude', 'SocketAgentRecovery')) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (!$task) { continue }
            # The launcher holds the server in a kill-on-close job, so stopping
            # the task also ends node and every shell the agents started.
            if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
        }
        Get-NetFirewallRule -DisplayName 'SocketAgent Server (TCP *)', 'SocketAgent mDNS (UDP 5353)' -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
        $tools = Join-Path $env:LOCALAPPDATA 'SocketAgent\bin'
        $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if ($userPath) {
            $kept = $userPath.Split(';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $tools }
            [Environment]::SetEnvironmentVariable('PATH', ($kept -join ';'), 'User')
        }
        foreach ($path in @($tools, (Join-Path $env:LOCALAPPDATA 'SocketAgent\install-location.txt'))) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
        }
        exit 0
    }

    $existing = Find-Server
    $destination = if ($existing) { $existing } else { [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') }
    if (!$existing -and (Test-Path -LiteralPath $destination)) {
        if (@(Get-ChildItem -LiteralPath $destination -Force).Count) { throw "Choose an empty folder for the server. $destination already has files in it." }
        Remove-Item -LiteralPath $destination -Force
    }
    $env:SOCKETAGENT_UNATTENDED = '1'
    $env:SOCKETAGENT_INSTALL_DIR = $destination
    $support = Join-Path $PSScriptRoot 'server-support'
    Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'server-support.zip') -DestinationPath $support -Force
    $env:SOCKETAGENT_INSTALLER_SUPPORT = $support
    $logFolder = Join-Path $env:LOCALAPPDATA 'SocketAgent/setup-logs'
    New-Item -ItemType Directory -Force $logFolder | Out-Null
    $logFile = Join-Path $logFolder ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Write-Output 'PHASE:Preparing the server'
    & $bootstrap *>&1 | ForEach-Object {
        $line = ([string]$_).TrimEnd()
        # The unattended install never prints the pairing code or tokens, but
        # a line that looks like one stays out of the log regardless.
        if (!$line -or $line -match 'SA\|' -or $line -match '(PAIRING|AUTH)_TOKEN') { return }
        Add-Content -LiteralPath $logFile -Value $line
        Write-Output ('LOG:' + $line)
        if ($line -match '^--- (Phase [0-9]+: .+) ---$') {
            Write-Output ('PHASE:' + $Matches[1])
        } elseif ($line -match '^\s*\[X\] (.+)$' -and !$script:firstFailure -and $Matches[1] -notmatch '^(Phase|Error):') {
            # install.ps1 names the cause on its first [X] line; its closing
            # "failed during" message can leave the phase empty.
            $script:firstFailure = $Matches[1]
        }
    }
    Write-Result $destination
    if ($QrImage) {
        Write-Output 'PHASE:Creating the pairing code'
        $node = (Get-Command node -ErrorAction Stop).Source
        & $node (Join-Path $PSScriptRoot 'pairing-qr.js') (Join-Path $destination 'server') $QrImage $QrPixels
        if ($LASTEXITCODE -ne 0) { throw "The server is installed, but its pairing code could not be drawn. Run socketagent pair in a new terminal to show it." }
    }
} catch {
    if ($script:firstFailure) { Write-Output ('ERROR:' + $script:firstFailure); exit 1 }
    Write-Output ('ERROR:' + $_.Exception.Message)
    exit 1
}
