# Destructive lifecycle checks: run only in a disposable Windows installer VM.
param([Parameter(Mandatory=$true)][string]$Checkout, [switch]$DisposableVm)
$ErrorActionPreference = 'Stop'
if (-not $DisposableVm) { throw 'Use -DisposableVm only in a disposable test VM. This test stops and restarts SocketAgent.' }
$server=Join-Path $checkout 'server'
$node=(Get-Command node.exe).Source
. (Join-Path $server 'scripts\windows-service.ps1')
function Ready {
  $json = & $node (Join-Path $server 'scripts\check-health.js') 180
  if ($LASTEXITCODE) { throw 'Readiness failed' }
  return ($json | ConvertFrom-Json).pid
}
$originalPid = Ready
# Changing task action must not restart or alter principal, triggers, or settings.
$t=Get-ScheduledTask SocketAgent
$before=@{principal=$t.Principal;triggers=$t.Triggers;settings=$t.Settings} | ConvertTo-Json -Depth 12
$legacy=New-ScheduledTaskAction -Execute cmd.exe -Argument ('/c "' + (Join-Path $server 'run-service.bat') + '"') -WorkingDirectory $server
Set-ScheduledTask SocketAgent -Action $legacy | Out-Null
Update-SocketAgentTaskLauncher $server
$t=Get-ScheduledTask SocketAgent
$after=@{principal=$t.Principal;triggers=$t.Triggers;settings=$t.Settings} | ConvertTo-Json -Depth 12
if ($before -ne $after) { throw 'Migration changed task settings' }
if ((Ready) -ne $originalPid) { throw 'Migration interrupted the server' }
'PASS: legacy action migration preserves running PID and task settings'
Set-ScheduledTask SocketAgent -Action $legacy | Out-Null
# Kill only the confirmed server PID to test the supervisor loop.
Stop-Process -Id $originalPid -Force
Start-Sleep 8
$newPid = Ready
if ($newPid -eq $originalPid) { throw 'Server did not recover' }
if ([IO.Path]::GetFileName((Get-ScheduledTask SocketAgent).Actions[0].Execute) -notlike 'socketagent-launcher-*') { throw 'Server startup did not migrate legacy action' }
"PASS: crash recovery and automatic migration $originalPid -> $newPid"
# Stopping the owning launcher must clean up its descendants.
Stop-ScheduledTask SocketAgent
Start-Sleep 3
if (Get-Process -Id $newPid -ErrorAction SilentlyContinue) { throw 'Task stop orphaned node' }
'PASS: task stop cleans up server process'
# The separately scheduled recovery guard must restart the server.
& (Join-Path $server 'scripts\register-windows-recovery.ps1') -DelaySeconds 3
Start-Sleep 8
$recoveredPid = Ready
"PASS: recovery task restarted server PID $recoveredPid"
& (Join-Path $server 'test\windows-install-smoke.ps1') -Checkout $checkout
