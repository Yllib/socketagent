# Non-destructive regression test. Run with Windows PowerShell 5.1.
param([string]$HelperPath = (Join-Path $PSScriptRoot '..\scripts\windows-service.ps1'))
$ErrorActionPreference = 'Stop'
. $HelperPath
$fixture = Join-Path $env:TEMP ('socketagent-listener-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path (Join-Path $fixture 'old install\server') -Force | Out-Null
$directory = Join-Path $fixture 'old install\server'
Set-Content -LiteralPath (Join-Path $directory 'package.json') -Value '{"name":"socketagent-server"}'
$script:current = [pscustomobject]@{
    Name = 'node.exe'; ProcessId = 1234; CreationDate = [datetime]'2026-01-01'
    CommandLine = '"C:\Program Files\nodejs\node.exe" "' + $directory + '\dist\index.js"'
}
$original = $script:current
$script:stopped = @()
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) @([pscustomobject]@{OwningProcess=1234}, [pscustomobject]@{OwningProcess=1234}) }
function Get-CimInstance { param($ClassName, $Filter) $script:current }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stopped += $Id }
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    $failure = $null
    try { & $Action } catch { $failure = $_.Exception.Message }
    Assert ($failure -and $failure -match $Pattern) "Expected error matching $Pattern; got $failure"
}
try {
    $captured = @(Get-SocketAgentInstallListeners 8085)
    Assert ($captured.Count -eq 1) 'IPv4/IPv6 listeners must identify one process'
    Stop-SocketAgentInstallListeners $captured | Out-Null
    Assert ($script:stopped.Count -eq 1 -and $script:stopped[0] -eq 1234) 'Legacy orphan must be stopped'
    $script:stopped = @()
    $script:current = $null
    Stop-SocketAgentInstallListeners $captured | Out-Null
    Assert ($script:stopped.Count -eq 0) 'Already exited process must be ignored'
    $script:current = $original.PSObject.Copy()
    $script:current.CreationDate = [datetime]'2026-01-02'
    Assert-Throws { Stop-SocketAgentInstallListeners $captured } 'changed during setup'
    Assert ($script:stopped.Count -eq 0) 'Reused PID must not be stopped'
    $script:current = $original.PSObject.Copy()
    $script:current.CommandLine = 'node.exe C:\unrelated\dist\index.js'
    Assert-Throws { Get-SocketAgentInstallListeners 8085 } 'already in use'
    $script:current = $original.PSObject.Copy()
    $script:current.Name = 'other.exe'
    Assert-Throws { Get-SocketAgentInstallListeners 8085 } 'already in use'
    $script:current = $original
    Set-Content -LiteralPath (Join-Path $directory 'package.json') -Value '{"name":"another-server"}'
    Assert-Throws { Get-SocketAgentInstallListeners 8085 } 'already in use'
    Write-Output 'PASS: legacy listener cleanup, duplicate listeners, vanished processes, PID reuse, unrelated processes'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
