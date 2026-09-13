# Run in an interactive disposable Windows VM after installation. Does not reset pairing.
param([Parameter(Mandatory=$true)][string]$Checkout)
$ErrorActionPreference = 'Stop'
$server = Join-Path $Checkout 'server'
$node = (Get-Command node.exe).Source
. (Join-Path $server 'scripts\windows-service.ps1')
& $node (Join-Path $server 'scripts\check-health.js') 180
if ($LASTEXITCODE -ne 0) { throw 'Server readiness failed' }
$task = Get-ScheduledTask SocketAgent
if ($task.State -ne 'Running' -or $task.Principal.LogonType -ne 'Interactive') { throw 'Wrong task state or logon type' }
if ([IO.Path]::GetFileName($task.Actions[0].Execute) -notlike 'socketagent-launcher-*.exe') { throw 'Task uses a console launcher' }
$launchers = @(Get-Process | Where-Object { $_.ProcessName -like 'socketagent-launcher-*' })
if (-not $launchers -or @($launchers | Where-Object { $_.MainWindowHandle -ne 0 -or $_.SessionId -eq 0 }).Count) { throw 'Launcher has a window or is in Session 0' }
$env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
$probe = '$ErrorActionPreference="Stop"; claude --version; if ($LASTEXITCODE) { exit $LASTEXITCODE }; codex --version; if ($LASTEXITCODE) { exit $LASTEXITCODE }; socketagent status'
& powershell.exe -NoProfile -ExecutionPolicy Restricted -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe)))
if ($LASTEXITCODE -ne 0) { throw 'Commands failed under Restricted execution policy' }
# The scheduler must receive the child exit code, including failure codes.
$fixture = Join-Path $env:TEMP ('socketagent-launcher-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory $fixture | Out-Null
$legacy = $null
$descendant = $null
try {
    $batch = Join-Path $fixture 'exit test.bat'
    Set-Content $batch "@echo off`r`nexit /b 37" -Encoding ASCII
    $child = Start-Process (Get-SocketAgentLauncher) -ArgumentList ('"' + $batch + '"') -PassThru -Wait
    if ($child.ExitCode -ne 37) { throw "Launcher lost exit code: $($child.ExitCode)" }
    # Old CMD tasks can terminate only their original action. Its hidden child
    # must notice that exact parent exit and clean up the server tree.
    $pidFile = Join-Path $fixture 'child.pid'
    $script = Join-Path $fixture 'child.js'
    Set-Content $script 'require("fs").writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);' -Encoding ASCII
    $launcher = Get-SocketAgentLauncher
    Set-Content $batch "@echo off`r`nif `"%SOCKETAGENT_SUPERVISED%`"==`"1`" goto child`r`n`"$launcher`" --hide-parent-console `"%~f0`"`r`nexit /b %errorlevel%`r`n:child`r`n`"$node`" `"$script`" `"$pidFile`"" -Encoding ASCII
    $legacy = Start-Process $env:ComSpec -ArgumentList ('/d /s /c ""' + $batch + '""') -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $pidFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $pidFile)) { throw 'Legacy launcher child did not start' }
    $descendantPid = [int](Get-Content $pidFile)
    $descendant = Get-Process -Id $descendantPid
    $legacy.Refresh()
    if ($legacy.MainWindowHandle -ne 0) { throw 'Legacy launcher did not hide its parent console' }
    Stop-Process -Id $legacy.Id -Force
    Start-Sleep 2
    if (Get-Process -Id $descendantPid -ErrorAction SilentlyContinue) { throw 'Legacy launcher orphaned its child when the parent stopped' }
} finally {
    if ($legacy -and -not $legacy.HasExited) { $legacy.Kill() }
    if ($descendant -and -not $descendant.HasExited) { $descendant.Kill() }
    Remove-Item $fixture -Recurse -Force
}
Write-Output 'PASS: ready, hidden interactive task, restricted commands, launcher exit status, and legacy parent cleanup'
