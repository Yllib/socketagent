$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-service.ps1')
Get-SocketAgentLauncher | Out-Null
Update-SocketAgentTaskLauncher (Split-Path $PSScriptRoot -Parent)
