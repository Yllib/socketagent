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
$InstallDir = if ($env:SOCKETAGENT_INSTALL_DIR) { $env:SOCKETAGENT_INSTALL_DIR } else { Join-Path $env:USERPROFILE "socketagent" }

function Write-Ok($message) {
    Write-Host "  [OK] $message" -ForegroundColor Green
}

function Write-Warn($message) {
    Write-Host "  [!] $message" -ForegroundColor Yellow
}

function Test-CommandExists($command) {
    $null -ne (Get-Command $command -ErrorAction SilentlyContinue)
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
            winget install Git.Git --accept-source-agreements --accept-package-agreements --silent
        }
        if ($wingetResult.ExitCode -eq 0 -or $wingetResult.ExitCode -eq -1978335189) {
            $installedWithWinget = $true
        } else {
            Write-Warn "winget could not install Git. Trying the Git for Windows installer."
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

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Updating existing SocketAgent checkout..."
    & git -C $InstallDir fetch --prune origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    & git -C $InstallDir checkout $Branch
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
    & git -C $InstallDir pull --ff-only origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
} elseif (Test-Path $InstallDir) {
    throw "Install directory exists but is not a git checkout: $InstallDir. Set SOCKETAGENT_INSTALL_DIR to a different folder or remove that directory."
} else {
    Write-Host "Cloning SocketAgent..."
    & git clone --branch $Branch $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

$installer = Join-Path $InstallDir "install.ps1"
if (-not (Test-Path $installer)) {
    throw "Cannot find $installer"
}

Set-Location $InstallDir
& powershell -ExecutionPolicy Bypass -File $installer
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
