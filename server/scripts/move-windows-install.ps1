# Moves an install from before machine installs lived in ProgramData. The
# serving server runs this once, elevated or as SYSTEM; see
# moveToMachineInstall in src\windows-machine-service.ts, which then hands
# its own wrapper over and restarts. Delete it with that migration.
#
# Copies the checkout, the managed agent CLIs and browser runtime to
# %ProgramData%\SocketAgent, writes the new wrappers, and points the tasks at
# them. -Toolchain and -BrowserRuntime are where the server kept the managed
# agent CLIs and browser until now. -RestartServiceTask also restarts
# SocketAgentService, for when it is only standing by. Prints the new
# checkout's path last.
param([string]$Toolchain, [string]$BrowserRuntime, [switch]$RestartServiceTask)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-service.ps1')

$sourceRoot = Split-Path $SocketAgentServerDir -Parent
$destination = Get-SocketAgentMachineInstallDir
$destinationServer = Join-Path $destination 'server'
if (Test-SocketAgentMachineInstall $sourceRoot) { throw 'This checkout is already the machine install' }
$config = Get-Content (Join-Path $SocketAgentServerDir 'windows-service.json') -Raw | ConvertFrom-Json
$ownerSid = Get-SocketAgentProfileSid $config.profile

Initialize-SocketAgentMachineFolder
if (Test-Path -LiteralPath $destination) {
    # A copy the tasks already run is the install; anything else there is
    # left from an attempt that did not finish.
    if (Test-SocketAgentTasksUse $destinationServer) { throw "$destination is already in use" }
    Remove-Item -LiteralPath $destination -Recurse -Force
}
Copy-SocketAgentInstall $sourceRoot $destination $ownerSid
Set-Content -LiteralPath (Join-Path $destinationServer 'windows-service\moved-from.txt') -Value $sourceRoot -Encoding UTF8

# The agent CLIs and browser the server starts, from the owner's profile.
$machineRoot = Split-Path $destination -Parent
$newTools = Join-Path $machineRoot 'toolchains\npm-global'
$newRuntime = Join-Path $machineRoot 'browser-runtime'
foreach ($pair in @(@($Toolchain, $newTools), @($BrowserRuntime, $newRuntime))) {
    if (-not $pair[0] -or -not (Test-Path -LiteralPath $pair[0]) -or (Test-Path -LiteralPath $pair[1])) { continue }
    & robocopy.exe $pair[0] $pair[1] /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying $($pair[0]) failed (robocopy exit $LASTEXITCODE)" }
    & icacls.exe $pair[1] /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
    & icacls.exe $pair[1] /reset /T /C /Q | Out-Null
}
# The marker names the browser by its old path.
$marker = Join-Path $newRuntime 'executable-path'
if ($BrowserRuntime -and (Test-Path -LiteralPath $marker)) {
    $browser = (Get-Content -LiteralPath $marker -Raw).Trim()
    $oldRuntime = $BrowserRuntime.TrimEnd('\')
    if ($browser.StartsWith($oldRuntime + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Set-Content -LiteralPath $marker -Value ($newRuntime + $browser.Substring($oldRuntime.Length)) -Encoding ASCII
    }
}

# The new wrappers keep the old ones' PATH, node and PowerShell, with the
# agent CLIs now coming from the machine toolchain.
$batch = [IO.File]::ReadAllText((Join-Path $SocketAgentServerDir 'run-service.bat'))
$values = @{}
foreach ($name in @('PATH', 'NODE_EXE', 'POWERSHELL_EXE')) {
    if ($batch -notmatch ('(?m)^set "' + $name + '=(.*)"\r?$')) { throw "run-service.bat does not set $name" }
    $values[$name] = $Matches[1]
}
$servicePath = ($values.PATH.Split(';') | Where-Object { $_ } | ForEach-Object { if ($Toolchain -and $_.TrimEnd('\') -ieq $Toolchain.TrimEnd('\')) { $newTools } else { $_ } }) -join ';'
if (-not (($servicePath.Split(';') | ForEach-Object { $_.TrimEnd('\') }) -icontains $newTools)) { $servicePath = "$newTools;$servicePath" }
$saved = @{ PATH = $env:PATH; POWERSHELL_EXE = $env:POWERSHELL_EXE; SOCKETAGENT_NODE = $env:SOCKETAGENT_NODE }
try {
    $env:PATH = $servicePath
    $env:POWERSHELL_EXE = $values.POWERSHELL_EXE
    $env:SOCKETAGENT_NODE = $values.NODE_EXE
    & $values.NODE_EXE (Join-Path $destinationServer 'dist\windows-service-cli.js') wrapper --keep-config
    if ($LASTEXITCODE -ne 0) { throw "Could not write the wrappers in $destinationServer" }
} finally {
    foreach ($key in $saved.Keys) { if ($null -eq $saved[$key]) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue } else { Set-Item "Env:$key" $saved[$key] } }
}

Get-SocketAgentLauncher $destinationServer | Out-Null
Update-SocketAgentTaskLauncher $destinationServer $SocketAgentServerDir
if (-not (Test-SocketAgentTasksUse $destinationServer)) { throw 'No task was moved to the new install' }
if (Get-ScheduledTask -TaskName 'SocketAgentService' -ErrorAction SilentlyContinue) { Set-SocketAgentServiceTaskAccess }
# The recovery guard is armed from the old folder; the new wrapper arms its own.
& schtasks.exe /Delete /TN SocketAgentRecovery /F 2>&1 | Out-Null
if ($RestartServiceTask) {
    & schtasks.exe /End /TN SocketAgentService 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    & schtasks.exe /Run /TN SocketAgentService 2>&1 | Out-Null
}

# The desktop app finds the owner's install, and reads its token, from here.
$location = Join-Path $config.localAppData 'SocketAgent\install-location.txt'
New-Item -ItemType Directory -Force (Split-Path $location) | Out-Null
[IO.File]::WriteAllText($location, $destination, [Text.Encoding]::UTF8)
$destination
