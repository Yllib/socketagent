param([int]$DelaySeconds = 300)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-service.ps1')
$batch = Join-Path (Split-Path $PSScriptRoot -Parent) 'run-recovery.bat'
$action = New-SocketAgentTaskAction $batch
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($DelaySeconds)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SocketAgentRecovery' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Grant-SocketAgentTaskOwnerAccess 'SocketAgentRecovery'
