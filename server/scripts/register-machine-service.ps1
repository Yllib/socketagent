# Adds SocketAgentService to an install from before it existed. The owner's
# elevated server runs this once; see addMachineServiceTask in
# src\windows-machine-service.ts. Delete it with that migration.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-service.ps1')

$port = 8085
foreach ($line in Get-Content (Join-Path $SocketAgentServerDir '.env') -ErrorAction SilentlyContinue) {
    if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { $port = [int]$Matches[1] }
}
$batch = [IO.File]::ReadAllText((Join-Path $SocketAgentServerDir 'run-service.bat'))
if ($batch -notmatch '(?m)^set "NODE_EXE=(.+)"\r?$') { throw 'run-service.bat does not set NODE_EXE' }
Register-SocketAgentMachineService $port $Matches[1]
