# Shared by installation, startup migration, and the CLI. Dot-source to use.
function Get-SocketAgentLauncher {
    $source = Join-Path $PSScriptRoot 'windows-launcher.cs'
    $hash = (Get-FileHash $source -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
    $directory = Join-Path $env:LOCALAPPDATA 'SocketAgent\launchers'
    $launcher = Join-Path $directory "socketagent-launcher-$hash.exe"
    if (-not (Test-Path $launcher)) {
        New-Item -ItemType Directory -Force $directory | Out-Null
        $compiler = @(
            "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
            "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $compiler) { throw 'Windows .NET Framework compiler is missing; cannot build the background launcher.' }
        $temporary = Join-Path $directory "launcher-$PID.exe"
        try {
            $output = & $compiler /nologo /target:winexe /optimize+ "/out:$temporary" $source 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Background launcher compilation failed: $output" }
            if (-not (Test-Path $launcher)) {
                try { Move-Item $temporary $launcher -ErrorAction Stop }
                catch { if (-not (Test-Path $launcher)) { throw } }
            }
        } finally { Remove-Item $temporary -ErrorAction SilentlyContinue }
    }
    return $launcher
}

function New-SocketAgentTaskAction([string]$BatchFile) {
    New-ScheduledTaskAction -Execute (Get-SocketAgentLauncher) -Argument ('"' + $BatchFile + '"') -WorkingDirectory (Split-Path $BatchFile -Parent)
}

function Update-SocketAgentTaskLauncher([string]$ServerDirectory) {
    $batch = Join-Path $ServerDirectory 'run-service.bat'
    foreach ($name in @('SocketAgent', 'SocketClaude')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task -or $task.Actions.Count -ne 1) { continue }
        $action = $task.Actions[0]
        $exe = [IO.Path]::GetFileName($action.Execute)
        # Only migrate this checkout's known service action. Preserve custom tasks.
        $arguments = ([string]$action.Arguments).Trim()
        $quotedBatch = '"' + $batch + '"'
        $knownBatch = if ($exe -ieq 'cmd.exe') {
            $arguments -match ('^(?:/[ds]\s+)*/c\s+"?' + [regex]::Escape($quotedBatch) + '"?\s*$')
        } else { $arguments -ieq $quotedBatch }
        $knownVbs = $exe -ieq 'wscript.exe' -and $arguments.Trim('"') -ieq (Join-Path $ServerDirectory 'run-service-hidden.vbs')
        if (-not (($knownBatch -and ($exe -ieq 'cmd.exe' -or $exe -like 'socketagent-launcher-*.exe')) -or $knownVbs)) { continue }
        $replacement = New-SocketAgentTaskAction $batch
        if ($action.Execute -eq $replacement.Execute -and $action.Arguments -eq $replacement.Arguments) { continue }
        try {
            # Update the native definition and preserve its security descriptor,
            # principal, triggers, and settings in the same registration.
            $scheduler = New-Object -ComObject 'Schedule.Service'
            $scheduler.Connect()
            $folder = $scheduler.GetFolder('\')
            $registered = $folder.GetTask($name)
            $definition = $registered.Definition
            $security = $registered.GetSecurityDescriptor(4)
            $definition.Actions.Clear()
            $exec = $definition.Actions.Create(0)
            $exec.Path = $replacement.Execute
            $exec.Arguments = $replacement.Arguments
            $exec.WorkingDirectory = $replacement.WorkingDirectory
            $folder.RegisterTaskDefinition($name, $definition, 4, $null, $null, $definition.Principal.LogonType, $security) | Out-Null
            Write-Output "Updated $name background launcher; effective at the next task start."
        } catch {
            $denied = $_.FullyQualifiedErrorId -like '*80070005*'
            $exception = $_.Exception
            while ($exception) {
                if ($exception.HResult -eq -2147024891) { $denied = $true }
                $exception = $exception.InnerException
            }
            if (-not $denied) { throw }
            Write-Warning "Windows requires elevation to update the existing $name task. The background batch wrapper will hide its console at the next task start. Rerun setup from PowerShell opened with Run as administrator to also remove the initial console flash."
        }
    }
}

function Grant-SocketAgentTaskOwnerAccess([string]$TaskName) {
    # Setup registers the task for this user. Give that same user full control
    # of the task object so a later repair of its action is a question of
    # elevation alone, rather than also being denied by the task's own ACL.
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor ($task.GetSecurityDescriptor(4))
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($existingAce in $descriptor.DiscretionaryAcl) {
        if ($existingAce -is [Security.AccessControl.CommonAce] -and
            $existingAce.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
            $existingAce.SecurityIdentifier -eq $sid -and
            (($existingAce.AccessMask -band 0x10000000) -ne 0 -or ($existingAce.AccessMask -band 0x1f01ff) -eq 0x1f01ff)) { return }
    }
    $ace = New-Object Security.AccessControl.CommonAce ([Security.AccessControl.AceFlags]::None), ([Security.AccessControl.AceQualifier]::AccessAllowed), 0x10000000, $sid, $false, $null
    $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $ace)
    $task.SetSecurityDescriptor($descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access), 0)
}
