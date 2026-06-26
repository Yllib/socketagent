#Requires -Version 5.1
<#
.SYNOPSIS
    SocketAgent Windows Installer
.DESCRIPTION
    Installs everything needed to run SocketAgent server on Windows:
    Node.js, Claude Code CLI, OpenAI Codex CLI, server dependencies, configuration, and scheduled task.
    Displays a QR code at the end for phone pairing.
.PARAMETER ResetPairing
    Force regeneration of pairing token and relay keys (breaks existing phone pairings).
.PARAMETER Port
    Server port (default: 8085).
.PARAMETER Backends
    Agent backend selection: claude, codex, or both. If omitted, the installer prompts.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Backends codex
#>

param(
    [switch]$ResetPairing,
    [int]$Port = 8085,
    [string]$Backends = ""
)

$ErrorActionPreference = "Stop"

# ── Configuration ──
$RELAY_URL = "wss://relay.jarofdirt.info"
$CODEX_DEVICE_URL = "https://chatgpt.com/codex/device"
$TASK_NAME = "SocketAgent"
$NODE_MIN_VERSION = [version]"22.0.0"

# ── Paths ──
$REPO_ROOT = $PSScriptRoot
$SERVER_DIR = Join-Path $REPO_ROOT "server"
$ENV_FILE = Join-Path $SERVER_DIR ".env"
$DATA_DIR = Join-Path $env:USERPROFILE ".claude-assistant"
$KEYS_FILE = Join-Path $DATA_DIR "relay-keys.json"
$LOG_FILE = Join-Path $SERVER_DIR "socketagent.log"
$SETUP_SCRIPT = Join-Path (Join-Path $SERVER_DIR "scripts") "setup.js"

$currentPhase = ""
$serverBuildDone = $false

function Write-Phase($name) {
    $script:currentPhase = $name
    Write-Host ""
    Write-Host "--- $name ---" -ForegroundColor Cyan
}

function Write-Ok($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "  [!] $msg" -ForegroundColor Yellow
}

function Write-Fail($msg) {
    Write-Host "  [X] $msg" -ForegroundColor Red
}

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

function Test-PathListContains($pathList, $directory) {
    if (-not $pathList -or -not $directory) { return $false }
    $needle = $directory.TrimEnd("\")
    foreach ($part in $pathList.Split(";")) {
        if ($part.TrimEnd("\") -ieq $needle) { return $true }
    }
    return $false
}

function Add-DirectoryToPath($directory, [bool]$persistUser = $false) {
    if (-not $directory -or -not (Test-Path $directory)) { return }
    if (-not (Test-PathListContains $env:PATH $directory)) {
        $env:PATH = "$env:PATH;$directory"
    }
    if ($persistUser) {
        $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (-not (Test-PathListContains $userPath $directory)) {
            $newPath = if ($userPath) { "$userPath;$directory" } else { $directory }
            [System.Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
            Write-Ok "Added $directory to user PATH"
        }
    }
}

function Ensure-NpmGlobalBinOnPath {
    $dirs = @()
    if (-not (Test-CommandExists "npm")) { return }
    $prefixResult = Invoke-NativeCapture { npm prefix -g }
    if ($prefixResult.ExitCode -eq 0) {
        $prefix = ($prefixResult.Output | Where-Object { $_ } | Select-Object -First 1).ToString().Trim()
        if ($prefix) { $dirs += $prefix }
    }

    # npm's Windows shims normally live here; keep these as explicit fallbacks
    # for fresh installs where the current terminal has not picked up PATH yet.
    if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA "npm") }
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA "npm") }

    foreach ($dir in ($dirs | Where-Object { $_ } | Select-Object -Unique)) {
        Add-DirectoryToPath $dir $true
    }
}

function Add-CommandDirectoryToPath($commandName) {
    $cmd = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        Add-DirectoryToPath (Split-Path $cmd.Source -Parent) $true
    }
}

function Test-CommandExists($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Test-CodexAppServer {
    $result = Invoke-NativeCapture { codex app-server --help }
    return $result.ExitCode -eq 0
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$Command
    )

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

function Install-ServerDependenciesAndBuild {
    if ($script:serverBuildDone) {
        Write-Ok "Server dependencies already installed and built"
        return
    }

    Push-Location $SERVER_DIR
    try {
        $packageLock = Join-Path $SERVER_DIR "package-lock.json"
        if (Test-Path $packageLock) {
            Write-Host "  Running npm ci..."
            $npmResult = Invoke-NativeCapture { npm ci }
            $installLabel = "npm ci"
        } else {
            Write-Host "  Running npm install..."
            $npmResult = Invoke-NativeCapture { npm install }
            $installLabel = "npm install"
        }
        $npmOutput = $npmResult.Output
        $npmExit = $npmResult.ExitCode
        $npmOutput | ForEach-Object { Write-Host "    $_" }
        if ($npmExit -ne 0) { throw "$installLabel failed (exit code $npmExit)" }
        Write-Ok "Dependencies installed"

        Write-Host "  Compiling TypeScript..."
        $tscResult = Invoke-NativeCapture { npx tsc }
        $tscOutput = $tscResult.Output
        $tscExit = $tscResult.ExitCode
        $tscOutput | ForEach-Object { Write-Host "    $_" }
        if ($tscExit -ne 0) { throw "TypeScript compilation failed (exit code $tscExit)" }
        Write-Ok "Server built successfully"
        $script:serverBuildDone = $true
    } finally {
        Pop-Location
    }
}

function Show-QrCode($payload) {
    $qrScript = "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>{c.split('\n').forEach(l=>console.log('  '+l))})"
    Push-Location $SERVER_DIR
    try {
        $qrResult = Invoke-NativeCapture { node -e $qrScript $payload }
        if ($qrResult.ExitCode -eq 0) {
            $qrResult.Output | ForEach-Object { Write-Host $_ }
        } else {
            Write-Warn "QR code rendering failed. Open this link manually: $payload"
        }
    } finally {
        Pop-Location
    }
}

function Test-CodexAuthenticated {
    $authCandidates = @()
    if ($env:CODEX_HOME) {
        $authCandidates += (Join-Path $env:CODEX_HOME "auth.json")
    }
    $authCandidates += (Join-Path (Join-Path $env:USERPROFILE ".codex") "auth.json")

    foreach ($authFile in $authCandidates) {
        if ($authFile -and (Test-Path $authFile)) {
            return $true
        }
    }

    if (-not (Test-CommandExists "codex")) {
        return $false
    }

    $result = Invoke-NativeCapture { codex login status }
    $output = $result.Output
    $exitCode = $result.ExitCode

    if ($exitCode -eq 0) {
        return $true
    }

    $text = ($output | Out-String)
    return ($text -match "(?im)^\s*(Logged in|Authenticated)\b") -or ($text -match "ChatGPT")
}

function Invoke-CodexLogin {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & codex login --device-auth
        return $LASTEXITCODE
    } catch {
        Write-Warn "codex login reported: $($_.Exception.Message)"
        if ($null -ne $LASTEXITCODE) {
            return $LASTEXITCODE
        }
        return 1
    } finally {
        $ErrorActionPreference = $oldPreference
    }
}

function Invoke-ClaudeLogin {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & claude auth login
        return $LASTEXITCODE
    } catch {
        Write-Warn "claude login reported: $($_.Exception.Message)"
        if ($null -ne $LASTEXITCODE) {
            return $LASTEXITCODE
        }
        return 1
    } finally {
        $ErrorActionPreference = $oldPreference
    }
}

function Convert-BackendSelection($value) {
    if ($null -eq $value) { $value = "" }
    $normalized = $value.ToString().ToLowerInvariant().Replace(" ", "")
    switch ($normalized) {
        { $_ -in @("1", "codex", "openai") } { return "codex" }
        { $_ -in @("2", "claude", "anthropic") } { return "claude" }
        { $_ -in @("3", "both", "all", "claude,codex", "codex,claude") } { return "claude,codex" }
        default { throw "Invalid backend selection '$value'. Use claude, codex, or both." }
    }
}

function Install-SocketAgentCli {
    $toolsDir = Join-Path $env:LOCALAPPDATA "SocketAgent\bin"
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null

    $targetPs1 = Join-Path $REPO_ROOT "bin\socketagent.ps1"
    $socketAgentCmd = Join-Path $toolsDir "socketagent.cmd"
    $socketClaudeCmd = Join-Path $toolsDir "socketclaude.cmd"
    $cmdContent = "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"$targetPs1`" %*`r`n"
    Set-Content -Path $socketAgentCmd -Value $cmdContent -Encoding ASCII
    Set-Content -Path $socketClaudeCmd -Value $cmdContent -Encoding ASCII

    $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $parts = @()
    if ($userPath) { $parts = $userPath.Split(";") | Where-Object { $_ } }
    $alreadyOnPath = $parts | Where-Object { $_.TrimEnd("\") -ieq $toolsDir.TrimEnd("\") }
    if (-not $alreadyOnPath) {
        $newPath = if ($userPath) { "$userPath;$toolsDir" } else { $toolsDir }
        [System.Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        $env:PATH = "$env:PATH;$toolsDir"
        Write-Ok "Added $toolsDir to user PATH"
    }

    Write-Ok "Installed socketagent command to $toolsDir"
}

# ══════════════════════════════════════════════
#  Banner
# ══════════════════════════════════════════════

Write-Host ""
Write-Host "  SocketAgent Installer" -ForegroundColor Cyan
Write-Host "  ======================" -ForegroundColor Cyan
Write-Host ""

# Verify we're in the right directory
if (-not (Test-Path $SERVER_DIR)) {
    Write-Fail "Cannot find server/ directory. Run this script from the SocketAgent repo root."
    exit 1
}

if (-not (Test-Path (Join-Path $SERVER_DIR "package.json"))) {
    Write-Fail "Cannot find server/package.json. Is this the SocketAgent repository?"
    exit 1
}

try {

# ── Pre-flight: check if port is available ──
$existingTask = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
$portInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    # Check if it's our own task — that's fine, we'll stop it in Phase 6
    $ourPids = @()
    if ($existingTask -and $existingTask.State -eq "Running") {
        $ourPids = (Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -in
            (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$TASK_NAME*" -or $_.CommandLine -like "*run-service*" }).ProcessId -or
            $_.CommandLine -like "*socketagent*dist*index.js*"
        }).ProcessId
    }
    $conflictPids = $portInUse.OwningProcess | Where-Object { $_ -notin $ourPids }
    if ($conflictPids) {
        $procInfo = Get-Process -Id $conflictPids[0] -ErrorAction SilentlyContinue
        $procName = if ($procInfo) { "$($procInfo.ProcessName) (PID $($conflictPids[0]))" } else { "PID $($conflictPids[0])" }
        Write-Fail "Port $Port is already in use by $procName"
        Write-Host ""
        Write-Host "  Use a different port:  powershell -File install.ps1 -Port 8086" -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
}

Write-Phase "Backend Selection"
if (-not $Backends) {
    Write-Host "  Which agent backend(s) should this server use?"
    Write-Host "    1) Codex only"
    Write-Host "    2) Claude only"
    Write-Host "    3) Both Claude and Codex"
    Write-Host ""
    $Backends = Read-Host "  Choose [3]"
    if (-not $Backends) { $Backends = "3" }
}
$enabledBackends = Convert-BackendSelection $Backends
$installClaude = (",$enabledBackends,").Contains(",claude,")
$installCodex = (",$enabledBackends,").Contains(",codex,")
Write-Ok "Selected backends: $enabledBackends"

# ══════════════════════════════════════════════
#  Phase 1: Node.js & Git
# ══════════════════════════════════════════════

Write-Phase "Phase 1: Node.js & Git"

# ── Git ──
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitVer = & git --version 2>$null
    Write-Ok "Git already installed ($gitVer)"
} else {
    Write-Host "  Git is required for auto-updates. Installing..."
    $gitInstalledWithWinget = $false
    if (Test-CommandExists "winget") {
        Write-Host "  Installing Git via winget..."
        $wingetResult = Invoke-NativeCapture { winget install Git.Git --accept-source-agreements --accept-package-agreements --silent }
        $wingetOutput = $wingetResult.Output
        $wingetExit = $wingetResult.ExitCode
        if ($wingetExit -eq 0 -or $wingetExit -eq -1978335189) {
            $gitInstalledWithWinget = $true
        } else {
            Write-Warn "winget install Git failed (exit code $wingetExit). Falling back to direct installer."
            $wingetOutput | ForEach-Object { Write-Host "    $_" }
        }
    }
    if (-not $gitInstalledWithWinget) {
        Write-Host "  Downloading Git installer..."
        $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
        $gitPath = Join-Path $env:TEMP "git-installer.exe"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitPath -UseBasicParsing
        Write-Host "  Running Git installer (may request admin)..."
        $gitProc = Start-Process $gitPath -ArgumentList "/VERYSILENT /NORESTART" -Verb RunAs -Wait -PassThru
        if ($gitProc.ExitCode -ne 0) {
            throw "Git installer failed or was canceled (exit code $($gitProc.ExitCode))"
        }
    }

    Refresh-Path

    $gitVer = & git --version 2>$null
    if (-not $gitVer) {
        Write-Warn "Git installation may require a terminal restart. Auto-updates will be unavailable until git is on PATH."
    } else {
        Write-Ok "Git installed ($gitVer)"
    }
}

# ── Node.js ──
$nodeInstalled = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $rawVersion = & node --version 2>$null
    if ($rawVersion) {
        $nodeVersion = [version]($rawVersion -replace "^v", "")
        if ($nodeVersion -ge $NODE_MIN_VERSION) {
            Write-Ok "Node.js $rawVersion already installed"
            $nodeInstalled = $true
        } else {
            Write-Warn "Node.js $rawVersion found but $NODE_MIN_VERSION+ required. Upgrading..."
        }
    }
}

if (-not $nodeInstalled) {
    $nodeInstalledWithWinget = $false
    if (Test-CommandExists "winget") {
        Write-Host "  Installing Node.js via winget..."
        $wingetResult = Invoke-NativeCapture { winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent }
        $wingetOutput = $wingetResult.Output
        $wingetExit = $wingetResult.ExitCode
        if ($wingetExit -eq 0 -or $wingetExit -eq -1978335189) {
            # -1978335189 = "already installed" in winget
            $nodeInstalledWithWinget = $true
        } else {
            Write-Warn "winget install Node.js failed (exit code $wingetExit). Falling back to direct installer."
            $wingetOutput | ForEach-Object { Write-Host "    $_" }
        }
    }
    if (-not $nodeInstalledWithWinget) {
        Write-Host "  Downloading Node.js installer..."
        $msiUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        $msiPath = Join-Path $env:TEMP "nodejs-installer.msi"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "  Running Node.js installer (may request admin)..."
        $nodeProc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Verb RunAs -Wait -PassThru
        if ($nodeProc.ExitCode -ne 0) {
            throw "Node.js installer failed or was canceled (exit code $($nodeProc.ExitCode))"
        }
    }

    Refresh-Path

    $rawVersion = & node --version 2>$null
    if (-not $rawVersion) {
        throw "Node.js installation failed. Please install Node.js 22+ manually from https://nodejs.org/"
    }
    Write-Ok "Node.js $rawVersion installed"
}
Ensure-NpmGlobalBinOnPath

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 2: Claude Code CLI"

if (-not $installClaude) {
    Write-Ok "Skipped (Claude not selected)"
} else {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) {
        $claudeVer = & claude --version 2>$null
        Write-Ok "Claude Code CLI already installed ($claudeVer)"
    } else {
        Write-Host "  Installing Claude Code CLI..."
        $cliResult = Invoke-NativeCapture { npm install -g @anthropic-ai/claude-code }
        $cliOutput = $cliResult.Output
        $cliExit = $cliResult.ExitCode
        $cliOutput | ForEach-Object { Write-Host "    $_" }
        if ($cliExit -ne 0) {
            throw "npm install -g @anthropic-ai/claude-code failed (exit code $cliExit)"
        }

        Refresh-Path

        $claudeVer = & claude --version 2>$null
        if (-not $claudeVer) {
            throw "Claude Code CLI installation failed. Try running: npm install -g @anthropic-ai/claude-code"
        }
        Write-Ok "Claude Code CLI installed ($claudeVer)"
    }
    Add-CommandDirectoryToPath "claude"
}

# ══════════════════════════════════════════════
#  Phase 3: Claude Code Authentication
# ══════════════════════════════════════════════

Write-Phase "Phase 3: Claude Code Authentication"

if (-not $installClaude) {
    Write-Ok "Skipped (Claude not selected)"
} else {
    $claudeDir = Join-Path $env:USERPROFILE ".claude"
    $credFiles = @(
        (Join-Path $claudeDir "credentials.json"),
        (Join-Path $claudeDir ".credentials.json")
    )

    $isAuthenticated = $false
    foreach ($f in $credFiles) {
        if (Test-Path $f) {
            $isAuthenticated = $true
            break
        }
    }

    if ($isAuthenticated) {
        Write-Ok "Claude Code credentials found"
    } else {
        Write-Warn "Claude Code is not authenticated."
        Write-Host "  Running 'claude auth login' -- this will open your browser."
        Write-Host "  Complete the login, then return to this window."
        Write-Host ""
        Read-Host "  Press Enter to start login"

        $claudeLoginExit = Invoke-ClaudeLogin
        if ($claudeLoginExit -ne 0) {
            Write-Warn "claude login exited with code $claudeLoginExit; checking for credentials anyway."
        }

        # Re-check
        $isAuthenticated = $false
        foreach ($f in $credFiles) {
            if (Test-Path $f) {
                $isAuthenticated = $true
                break
            }
        }
        if ($isAuthenticated) {
            Write-Ok "Authentication successful"
        } else {
            Write-Warn "Could not verify authentication. You can run 'claude login' later."
        }
    }
}

# ══════════════════════════════════════════════
#  Phase 4: OpenAI Codex CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 4: OpenAI Codex CLI"

if (-not $installCodex) {
    Write-Ok "Skipped (Codex not selected)"
} else {
    $codexInstalled = $false
    $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($codexCmd) {
        $codexVer = & codex --version 2>$null
        if (Test-CodexAppServer) {
            Write-Ok "OpenAI Codex CLI already installed ($codexVer)"
            $codexInstalled = $true
        } else {
            Write-Warn "OpenAI Codex CLI found ($codexVer) but app-server is unavailable. Updating..."
        }
    }

    if (-not $codexInstalled) {
        Write-Host "  Installing OpenAI Codex CLI..."
        $codexResult = Invoke-NativeCapture { npm install -g @openai/codex }
        $codexOutput = $codexResult.Output
        $codexExit = $codexResult.ExitCode
        $codexOutput | ForEach-Object { Write-Host "    $_" }
        if ($codexExit -ne 0) {
            throw "npm install -g @openai/codex failed (exit code $codexExit)"
        }

        Refresh-Path
        Ensure-NpmGlobalBinOnPath

        $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
        if (-not $codexCmd) {
            throw "OpenAI Codex CLI installation failed. Try running: npm install -g @openai/codex"
        }
        $codexVer = & codex --version 2>$null
        if (-not (Test-CodexAppServer)) {
            throw "OpenAI Codex CLI installed, but 'codex app-server' is unavailable. Try running: npm install -g @openai/codex@latest"
        }
        Write-Ok "OpenAI Codex CLI installed ($codexVer)"
    }
    Add-CommandDirectoryToPath "codex"
}

# ══════════════════════════════════════════════
#  Phase 5: OpenAI Codex Authentication
# ══════════════════════════════════════════════

Write-Phase "Phase 5: OpenAI Codex Authentication"

if (-not $installCodex) {
    Write-Ok "Skipped (Codex not selected)"
} else {
    $codexAuthed = Test-CodexAuthenticated

    if ($codexAuthed) {
        Write-Ok "OpenAI Codex credentials found"
    } else {
        Write-Warn "OpenAI Codex is not authenticated."
        Write-Host "  Running 'codex login --device-auth'."
        Write-Host "  Scan this QR code with your phone, or open the link on this PC:"
        Write-Host "  $CODEX_DEVICE_URL"
        Write-Host ""
        Install-ServerDependenciesAndBuild
        Show-QrCode $CODEX_DEVICE_URL
        Write-Host ""
        Write-Host "  The Codex CLI will print a one-time code. Enter that code on the page."
        Write-Host "  Complete the login, then return to this window."
        Write-Host ""
        Read-Host "  Press Enter to start login"

        $codexLoginExit = Invoke-CodexLogin
        if ($codexLoginExit -ne 0) {
            Write-Warn "codex login exited with code $codexLoginExit; checking for credentials anyway."
        }

        $codexAuthed = Test-CodexAuthenticated
        if ($codexAuthed) {
            Write-Ok "Codex authentication successful"
        } else {
            Write-Warn "Could not verify Codex authentication. Codex sessions will be hidden until you run 'codex login'."
        }
    }
}

# ══════════════════════════════════════════════
#  Phase 6: Install Dependencies & Build
# ══════════════════════════════════════════════

Write-Phase "Phase 6: Install Dependencies & Build"

Install-ServerDependenciesAndBuild

# ══════════════════════════════════════════════
#  Phase 7: Generate Configuration
# ══════════════════════════════════════════════

Write-Phase "Phase 7: Generate Configuration"

# Handle --ResetPairing flag
if ($ResetPairing) {
    Write-Warn "Resetting pairing data..."
    if (Test-Path $KEYS_FILE) { Remove-Item $KEYS_FILE -Force }
    # Remove PAIRING_TOKEN from .env so setup.js regenerates it
    if (Test-Path $ENV_FILE) {
        $envContent = Get-Content $ENV_FILE | Where-Object { $_ -notmatch "^PAIRING_TOKEN=" }
        Set-Content $ENV_FILE $envContent
    }
}

$isUpgrade = Test-Path $ENV_FILE

$setupResult = Invoke-NativeCapture {
    node $SETUP_SCRIPT `
        --envfile $ENV_FILE `
        --keysfile $KEYS_FILE `
        --relay-url $RELAY_URL `
        --default-cwd $env:USERPROFILE `
        --port $Port `
        --enabled-backends $enabledBackends
}
$setupOutput = $setupResult.Output

if ($setupResult.ExitCode -ne 0) { throw "Configuration generation failed (exit code $($setupResult.ExitCode))" }

# QR payload is the last line of output
$qrPayload = ($setupOutput | Select-Object -Last 1)

# Print non-QR output
$setupOutput | Select-Object -SkipLast 1 | ForEach-Object { Write-Host "    $_" }

if ($isUpgrade) {
    Write-Ok "Configuration updated (existing tokens preserved)"
} else {
    Write-Ok "Configuration generated"
}

# ══════════════════════════════════════════════
#  Phase 8: Register Scheduled Task
# ══════════════════════════════════════════════

Write-Phase "Phase 8: Register Windows Service"

$nodeExe = (Get-Command node).Source
$serverScript = Join-Path (Join-Path $SERVER_DIR "dist") "index.js"

# Stop and remove existing task
$existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME
        Start-Sleep -Seconds 2
    }
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Write-Host "  Removed existing task"
}

# Generate run-service.bat with restart loop
# This ensures the server auto-restarts after updates (process.exit(1))
$batFile = Join-Path $SERVER_DIR "run-service.bat"
$servicePath = $env:PATH -replace '"', ''
foreach ($commandName in @("claude", "codex")) {
    $cmd = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        $cmdDir = (Split-Path $cmd.Source -Parent) -replace '"', ''
        if (-not (Test-PathListContains $servicePath $cmdDir)) {
            $servicePath = "$servicePath;$cmdDir"
        }
    }
}
$batContent = @"
@echo off
set "HOME=$env:USERPROFILE"
set "PATH=$servicePath"
cd /d "$SERVER_DIR"
:loop
"$nodeExe" "$serverScript" >> "$LOG_FILE" 2>&1
echo Server exited (%ERRORLEVEL%), restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
"@
Set-Content -Path $batFile -Value $batContent -Encoding ASCII
Write-Ok "Generated run-service.bat"

$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$batFile`"" `
    -WorkingDirectory $SERVER_DIR

# Settings: run indefinitely, restart on failure, allow on battery
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$registeredTaskMode = "startup"
try {
    # Preferred: current user, S4U logon, at startup. This runs without an
    # active desktop session, but some Windows account/policy setups reject it.
    $startupTrigger = New-ScheduledTaskTrigger -AtStartup
    $startupPrincipal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType S4U `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TASK_NAME `
        -Action $action `
        -Trigger $startupTrigger `
        -Settings $settings `
        -Principal $startupPrincipal `
        -Description "SocketAgent WebSocket server" | Out-Null
} catch {
    Write-Warn "Could not register startup task using S4U: $($_.Exception.Message)"
    Write-Warn "Falling back to an interactive logon task for this Windows account."
    $partialTask = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($partialTask) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    }

    $registeredTaskMode = "logon"
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    $logonPrincipal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType Interactive `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TASK_NAME `
        -Action $action `
        -Trigger $logonTrigger `
        -Settings $settings `
        -Principal $logonPrincipal `
        -Description "SocketAgent WebSocket server" | Out-Null
}

if ($registeredTaskMode -eq "startup") {
    Write-Ok "Registered as scheduled task '$TASK_NAME' (startup)"
} else {
    Write-Ok "Registered as scheduled task '$TASK_NAME' (logon fallback)"
}

# Add Windows Firewall rule (requires admin — skip silently if not elevated)
$fwRuleName = "SocketAgent Server (TCP $Port)"
try {
    $existingRule = Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
    if (-not $existingRule) {
        New-NetFirewallRule `
            -DisplayName $fwRuleName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $Port `
            -Profile Private,Domain `
            -Description "Allow inbound connections to SocketAgent server" | Out-Null
        Write-Ok "Firewall rule added for port $Port (Private/Domain networks)"
    } else {
        Write-Ok "Firewall rule already exists for port $Port"
    }
} catch {
    Write-Warn "Could not add firewall rule (requires admin). You may need to allow port $Port manually."
}

# Start immediately
try {
    Start-ScheduledTask -TaskName $TASK_NAME
    Write-Host "  Starting server..."
} catch {
    Write-Warn "Could not start scheduled task: $($_.Exception.Message)"
    Write-Warn "Starting server directly for this session; it will start from the task on next logon/startup."
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$batFile`"" -WindowStyle Hidden | Out-Null
}
Start-Sleep -Seconds 3

$taskInfo = Get-ScheduledTask -TaskName $TASK_NAME
if ($taskInfo.State -eq "Running") {
    Write-Ok "Server is running on port $Port"
} else {
    Write-Warn "Server may not have started. Check: Get-ScheduledTask -TaskName $TASK_NAME"
    Write-Warn "Logs: $LOG_FILE"
}

# ══════════════════════════════════════════════
#  Phase 9: Install CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 9: Install CLI"
Install-SocketAgentCli

# ══════════════════════════════════════════════
#  Phase 10: QR Code & Summary
# ══════════════════════════════════════════════

Write-Phase "Phase 10: Phone Pairing"

# Set UTF-8 for QR code rendering in legacy terminals
if ($null -eq $env:WT_SESSION) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 | Out-Null
}

Write-Host ""
Write-Host "  Scan this QR code with the SocketAgent app:" -ForegroundColor Cyan
Write-Host ""

# Generate QR using server's qrcode-terminal package
Push-Location $SERVER_DIR
try {
    $qrScript = "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>console.log(c))"
    & node -e $qrScript $qrPayload 2>$null | ForEach-Object { Write-Host "  $_" }
} catch {
    Write-Warn "QR code rendering failed. Use manual pairing below."
}
Pop-Location

Write-Host ""
Write-Host "  If QR scan doesn't work, paste this in the app:" -ForegroundColor Yellow
Write-Host "  $qrPayload" -ForegroundColor Gray
Write-Host ""

# ── Success ──
Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "   Installation complete!" -ForegroundColor Green
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  The server starts automatically when you log in."
Write-Host ""
Write-Host "  Management commands:" -ForegroundColor Cyan
Write-Host "    CLI:      socketagent help"
Write-Host "    Status:   Get-ScheduledTask -TaskName $TASK_NAME"
Write-Host "    Start:    Start-ScheduledTask -TaskName $TASK_NAME"
Write-Host "    Stop:     Stop-ScheduledTask -TaskName $TASK_NAME"
Write-Host "    Logs:     Get-Content '$LOG_FILE' -Tail 50"
Write-Host "    Uninstall: powershell -File uninstall.ps1"
Write-Host ""

} catch {
    Write-Host ""
    Write-Host "  ===========================================" -ForegroundColor Red
    Write-Host "   Installation failed!" -ForegroundColor Red
    Write-Host "  ===========================================" -ForegroundColor Red
    Write-Host ""
    Write-Fail "Phase: $currentPhase"
    Write-Fail "Error: $($_.Exception.Message)"
    Write-Host ""
    Write-Host "  Troubleshooting:" -ForegroundColor Yellow

    switch -Wildcard ($currentPhase) {
        "*Node*" {
            Write-Host "    - Install Node.js 22+ manually: https://nodejs.org/"
            Write-Host "    - Then re-run this installer"
        }
        "*Claude Code CLI*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: npm install -g @anthropic-ai/claude-code"
        }
        "*OpenAI Codex CLI*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: npm install -g @openai/codex"
        }
        "*Authentication*" {
            Write-Host "    - Run 'claude login' or 'codex login' manually"
            Write-Host "    - Then re-run this installer"
        }
        "*Dependencies*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: cd server && npm install"
        }
        "*Configuration*" {
            Write-Host "    - Check that server/scripts/setup.js exists"
            Write-Host "    - Try: cd server && node scripts/setup.js --help"
        }
        "*Service*" {
            Write-Host "    - Check Task Scheduler for errors"
            Write-Host "    - Try starting manually: cd server && node dist/index.js"
        }
        default {
            Write-Host "    - Check the error message above"
            Write-Host "    - Re-run the installer to retry"
        }
    }
    Write-Host ""
    exit 1
}
