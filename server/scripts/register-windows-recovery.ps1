param([int]$DelaySeconds = 300)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-service.ps1')
$batch = Join-Path (Split-Path $PSScriptRoot -Parent) 'run-recovery.bat'
$action = New-SocketAgentTaskAction $batch
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($DelaySeconds)
# Windows only accepts a Highest principal from an elevated caller. A limited
# install registers a Limited guard instead, so its updates still restart.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$runLevel = if ($elevated) { 'Highest' } else { 'Limited' }
# SYSTEM has no interactive logon, so its guard runs as a service account.
$principal = if ($identity.User.Value -eq 'S-1-5-18') {
    New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
} else {
    New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel $runLevel
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SocketAgentRecovery' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Grant-SocketAgentTaskOwnerAccess 'SocketAgentRecovery'
