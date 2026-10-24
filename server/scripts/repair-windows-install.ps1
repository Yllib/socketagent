# The reads and changes behind src\windows-install-repair.ts, which repairs
# installs that the interrupted move to ProgramData from 384e156 left behind.
# Delete it with that module.
#
#   -Inspect -MachineRoot <dir> -ExcludePid <pid>
#     Prints JSON: the SocketAgent tasks' first action and state, and every
#     process whose command line names something under -MachineRoot, except
#     -ExcludePid and this PowerShell.
#   -PointTasks -ServerDirectory <dir> -PreviousServerDirectory <dir>
#     Points the tasks that run the previous checkout's wrapper at this one's,
#     through the owner's launcher. Keeps each task's principal, triggers,
#     settings and security descriptor.
#   -RestartServiceTask
#     Ends SocketAgentService and starts it again from its current action.
param(
    [switch]$Inspect, [string]$MachineRoot, [int]$ExcludePid,
    [switch]$PointTasks, [string]$ServerDirectory, [string]$PreviousServerDirectory,
    [switch]$RestartServiceTask
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-service.ps1')

if ($Inspect) {
    $tasks = @{}
    foreach ($name in @('SocketAgent', 'SocketClaude', 'SocketAgentService')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) { continue }
        $actions = @($task.Actions)
        $tasks[$name] = @{
            execute = [string]$actions[0].Execute
            arguments = [string]$actions[0].Arguments
            actions = $actions.Count
            state = [string]$task.State
        }
    }
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.ProcessId -ne $PID -and $_.ProcessId -ne $ExcludePid -and
        $_.CommandLine.IndexOf($MachineRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object {
        $sid = try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid } catch { '' }
        @{ pid = [int]$_.ProcessId; name = [string]$_.Name; sid = [string]$sid; commandLine = [string]$_.CommandLine }
    })
    @{ tasks = $tasks; processes = $processes } | ConvertTo-Json -Depth 4 -Compress
    return
}
if ($PointTasks) {
    if (-not $ServerDirectory -or -not $PreviousServerDirectory) { throw '-PointTasks needs -ServerDirectory and -PreviousServerDirectory' }
    Get-SocketAgentLauncher | Out-Null
    Update-SocketAgentTaskLauncher $ServerDirectory $PreviousServerDirectory
    return
}
if ($RestartServiceTask) {
    & schtasks.exe /End /TN SocketAgentService 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    & schtasks.exe /Run /TN SocketAgentService 2>&1 | Out-Null
    return
}
throw 'Pass -Inspect, -PointTasks or -RestartServiceTask'
