#Requires -Version 5.1
<#
.SYNOPSIS
    SocketAgent Windows bootstrap installer.
.DESCRIPTION
    Installs Git if needed, clones or updates the SocketAgent repo, then runs install.ps1.
#>

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:SOCKETAGENT_REPO_URL) { $env:SOCKETAGENT_REPO_URL } else { "https://github.com/Yllib/socketagent.git" }
$Branch = if ($env:SOCKETAGENT_BRANCH) { $env:SOCKETAGENT_BRANCH } else { "master" }
$MachineInstallDir = Join-Path $env:ProgramData 'SocketAgent\socketagent'

# Finds this Windows user's existing SocketAgent checkout, or returns nothing.
# The machine install comes first: the location file is the user's to edit,
# and setup runs what it finds with administrator rights.
function Find-SocketAgentInstall {
    $candidates = @($MachineInstallDir)
    $locationFile = Join-Path $env:LOCALAPPDATA 'SocketAgent\install-location.txt'
    if (Test-Path $locationFile) { $candidates += (Get-Content $locationFile -Raw).Trim() }
    foreach ($taskName in @('SocketAgent', 'SocketClaude')) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            foreach ($action in $task.Actions) {
                if ($action.WorkingDirectory) { $candidates += Split-Path $action.WorkingDirectory -Parent }
                if ($action.Arguments -match '"([^"\r\n]+)\\server\\run-service(?:-hidden)?\.(?:bat|vbs)"') { $candidates += $Matches[1] }
            }
        }
    }
    $candidates += Join-Path $env:USERPROFILE 'socketagent'
    $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ '.git')) -and (Test-Path (Join-Path $_ 'install.ps1')) } | Select-Object -First 1
}

# The Windows server installer asks where an existing server lives before it
# offers a folder, so a second server is never installed beside the first.
if ($env:SOCKETAGENT_FIND_INSTALL -eq '1') {
    Find-SocketAgentInstall
    exit 0
}

$InstallDir = $env:SOCKETAGENT_INSTALL_DIR
if (-not $InstallDir) {
    $InstallDir = Find-SocketAgentInstall
    if ($InstallDir) { Write-Host "Using existing installation: $InstallDir" }
    else {
        $InstallDir = Join-Path $env:USERPROFILE 'socketagent'
        Write-Host "Server destination: $InstallDir"
        if ($env:SOCKETAGENT_UNATTENDED -ne '1' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
            $choice = Read-Host 'Press Enter to use this folder, or type another folder'
            if ($choice.Trim()) { $InstallDir = $choice.Trim().Trim('"') }
        }
    }
}
$InstallDir = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($InstallDir))

function Write-Ok($message) {
    Write-Host "  [OK] $message" -ForegroundColor Green
}

function Write-Warn($message) {
    Write-Host "  [!] $message" -ForegroundColor Yellow
}

function Test-CommandExists($command) {
    $null -ne (Get-Command $command -ErrorAction SilentlyContinue)
}

function Get-CommandWithoutStoreAlias($command) {
    $resolved = Get-Command $command -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Source -like "*\Microsoft\WindowsApps\*") {
        return $null
    }
    return $resolved
}

function Invoke-NativeCapture {
    param([Parameter(Mandatory=$true)][scriptblock]$Command)

    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $Command 2>&1
        $exitCode = $LASTEXITCODE
    } catch {
        $output = @($_.Exception.Message)
        $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    } finally {
        $ErrorActionPreference = $oldPreference
    }

    return [pscustomobject]@{
        Output = @($output)
        ExitCode = $exitCode
    }
}

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = "$machinePath;$userPath"

    $commonGitPaths = @(
        "$env:ProgramFiles\Git\cmd",
        "${env:ProgramFiles(x86)}\Git\cmd",
        "$env:LOCALAPPDATA\Programs\Git\cmd"
    )
    foreach ($dir in $commonGitPaths) {
        if ($dir -and (Test-Path $dir) -and -not ($env:PATH.Split(";") -contains $dir)) {
            $env:PATH = "$env:PATH;$dir"
        }
    }
}

function Ensure-Git {
    Refresh-Path
    if (Test-CommandExists "git") {
        $gitVersion = (& git --version 2>$null | Out-String).Trim()
        Write-Ok "Git already installed ($gitVersion)"
        return
    }

    Write-Host "Installing Git..."
    $installedWithWinget = $false
    if (Test-CommandExists "winget") {
        $wingetResult = Invoke-NativeCapture {
            winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements --silent
        }
        if ($wingetResult.ExitCode -eq 0 -or $wingetResult.ExitCode -eq -1978335189) {
            Refresh-Path
            $installedWithWinget = $null -ne (Get-CommandWithoutStoreAlias "git")
            if (-not $installedWithWinget) {
                Write-Warn "WinGet finished, but Git is not runnable. Trying the Git for Windows installer."
            }
        } else {
            Write-Warn "WinGet could not install Git from the community repository. Trying the Git for Windows installer."
            $wingetResult.Output | ForEach-Object { Write-Host "    $_" }
        }
    }

    if (-not $installedWithWinget) {
        $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
        $gitInstaller = Join-Path $env:TEMP "socketagent-git-installer.exe"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
        $proc = Start-Process $gitInstaller -ArgumentList "/VERYSILENT /NORESTART" -Verb RunAs -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            throw "Git installer failed or was canceled (exit code $($proc.ExitCode))"
        }
    }

    Refresh-Path
    if (-not (Test-CommandExists "git")) {
        throw "Git was installed, but this terminal cannot find it yet. Close PowerShell, reopen it, and run the install command again."
    }
    $gitVersion = (& git --version 2>$null | Out-String).Trim()
    Write-Ok "Git installed ($gitVersion)"
}

Write-Host ""
Write-Host "SocketAgent Windows Installer" -ForegroundColor Cyan
Write-Host "Repo: $RepoUrl"
Write-Host "Install dir: $InstallDir"
Write-Host ""

Ensure-Git

$elevated = (New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ([IO.Path]::GetFullPath($InstallDir).TrimEnd('\') -ieq $MachineInstallDir -and -not $elevated) {
    throw "SocketAgent is installed in $MachineInstallDir, which only administrators can change. Rerun setup from PowerShell opened with Run as administrator."
}

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Updating existing SocketAgent checkout..."
    $gitResult = Invoke-NativeCapture { git -C $InstallDir fetch --prune origin $Branch }
    $gitResult.Output | ForEach-Object { Write-Host ([string]$_) }
    if ($gitResult.ExitCode -ne 0) { throw "git fetch failed" }
    $gitResult = Invoke-NativeCapture { git -C $InstallDir checkout $Branch }
    $gitResult.Output | ForEach-Object { Write-Host ([string]$_) }
    if ($gitResult.ExitCode -ne 0) { throw "git checkout failed" }
    $gitResult = Invoke-NativeCapture { git -C $InstallDir pull --ff-only origin $Branch }
    $gitResult.Output | ForEach-Object { Write-Host ([string]$_) }
    if ($gitResult.ExitCode -ne 0) { throw "git pull failed" }
} elseif (Test-Path $InstallDir) {
    throw "Install directory exists but is not a git checkout: $InstallDir. Set SOCKETAGENT_INSTALL_DIR to a different folder or remove that directory."
} else {
    Write-Host "Cloning SocketAgent..."
    $gitResult = Invoke-NativeCapture { git clone --branch $Branch $RepoUrl $InstallDir }
    $gitResult.Output | ForEach-Object { Write-Host ([string]$_) }
    if ($gitResult.ExitCode -ne 0) { throw "git clone failed" }
}

$installer = Join-Path $InstallDir "install.ps1"
if (-not (Test-Path $installer)) {
    throw "Cannot find $installer"
}

Set-Location $InstallDir

# The bootstrap is normally loaded with `irm ... | iex`, so it already runs in
# PowerShell. Starting powershell.exe again breaks on machines where Windows
# PowerShell is disabled but pwsh/current-host execution is allowed. The cloned
# script is local, so run it in this host after applying a process-only bypass.
try {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue
} catch {}

try {
    & $installer
} catch {
    Write-Host ""
    Write-Warn "SocketAgent did not finish installing. This window will stay open so the error is not lost."
    Write-Host "  Retry after correcting the error:" -ForegroundColor Yellow
    Write-Host "    & `"$installer`"" -ForegroundColor Gray
    Write-Host ""
    throw
}
