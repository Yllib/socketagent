# Shared by installation, startup migration, and the CLI. Dot-source to use.

# Local app data of the install's owner, from server\windows-service.json.
# Paths written into tasks come from here, so a server running as SYSTEM
# still points them at the owner's launcher rather than its own profile.
function Get-SocketAgentOwnerLocalAppData {
    $config = Join-Path (Split-Path $PSScriptRoot -Parent) 'windows-service.json'
    if (Test-Path $config) {
        $localAppData = (Get-Content $config -Raw | ConvertFrom-Json).localAppData
        if ($localAppData) { return $localAppData }
    }
    $systemRoot = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\') + '\'
    if (([IO.Path]::GetFullPath($env:LOCALAPPDATA) + '\').StartsWith($systemRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "No windows-service.json; refusing to place the SocketAgent launcher in the system profile $env:LOCALAPPDATA"
    }
    return $env:LOCALAPPDATA
}

function Get-SocketAgentLauncher {
    $source = Join-Path $PSScriptRoot 'windows-launcher.cs'
    $hash = (Get-FileHash $source -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
    $directory = Join-Path (Get-SocketAgentOwnerLocalAppData) 'SocketAgent\launchers'
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
    foreach ($name in @('SocketAgent', 'SocketClaude', 'SocketAgentService')) {
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

# The rest registers SocketAgentService, the SYSTEM task that serves while the
# owner is signed out. See src\windows-machine-service.ts.

$SocketAgentServerDir = Split-Path $PSScriptRoot -Parent

# Registers a task that runs as SYSTEM in Session 0.
function Register-SocketAgentSystemTask([string]$Name, $Action, $Trigger, $Settings) {
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $parameters = @{ TaskName = $Name; Action = $Action; Principal = $principal; Settings = $Settings; Force = $true }
    if ($Trigger) { $parameters.Trigger = $Trigger }
    Register-ScheduledTask @parameters | Out-Null
}

# C:\ProgramData\SocketAgent holds machine-server.json, which tells the
# desktop app under every account where this install answers and with which
# key; the server writes it. Only SYSTEM and administrators may write there,
# because ProgramData lets any user create files and the app trusts this one.
function Initialize-SocketAgentMachineFolder {
    $directory = Join-Path $env:ProgramData 'SocketAgent'
    New-Item -ItemType Directory -Force $directory | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $sid = New-Object Security.Principal.SecurityIdentifier $entry[0]
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, $entry[1], $inherit, 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
}

# Lets every signed-in account see and start the task, so the desktop app
# under any account can start the machine server. The task runs code only
# administrators can change.
function Grant-SocketAgentTaskStartAccess([string]$TaskName) {
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor ($task.GetSecurityDescriptor(4))
    $sid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-11'
    # FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, which Task Scheduler reads as read and run.
    $ace = New-Object Security.AccessControl.CommonAce ([Security.AccessControl.AceFlags]::None), ([Security.AccessControl.AceQualifier]::AccessAllowed), 0x1200a9, $sid, $false, $null
    $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $ace)
    $task.SetSecurityDescriptor($descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Access), 0)
}

# Inbound rules for the server's port, LAN discovery, and node itself. The
# program rule is what keeps Windows from asking whether node may listen.
# Returns warnings for the rules it could not add.
function Add-SocketAgentFirewallRules([int]$Port, [string]$NodeExe) {
    $rules = @(
        @{ DisplayName = "SocketAgent Server (TCP $Port)"; Protocol = 'TCP'; LocalPort = $Port; Description = 'Allow inbound connections to SocketAgent server' },
        @{ DisplayName = 'SocketAgent mDNS (UDP 5353)'; Protocol = 'UDP'; LocalPort = 5353; Description = 'Allow LAN discovery of the SocketAgent server' },
        @{ DisplayName = 'SocketAgent Node.js'; Program = $NodeExe; Description = 'Allow the SocketAgent server to listen without a firewall prompt' }
    )
    foreach ($rule in $rules) {
        try {
            $existing = Get-NetFirewallRule -DisplayName $rule.DisplayName -ErrorAction SilentlyContinue
            if ($existing -and $rule.Program) {
                $filter = $existing | Get-NetFirewallApplicationFilter
                if ($filter.Program -ieq $rule.Program) { continue }
                $existing | Remove-NetFirewallRule
            } elseif ($existing) { continue }
            New-NetFirewallRule @rule -Direction Inbound -Action Allow -Profile Private,Domain | Out-Null
            "Added firewall rule '$($rule.DisplayName)'"
        } catch {
            Write-Warning "Could not add firewall rule '$($rule.DisplayName)': $($_.Exception.Message)"
        }
    }
}

# SocketAgentService runs this checkout's run-service.bat as SYSTEM at
# startup, at any logon and every 5 minutes. Its wrapper waits while the
# owner's task serves, so it is started right away. Needs elevation.
function Register-SocketAgentMachineService([int]$Port, [string]$NodeExe) {
    $name = 'SocketAgentService'
    $batch = Join-Path $SocketAgentServerDir 'run-service.bat'
    if (-not (Test-Path $batch)) { throw "$batch is missing" }
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn), $repeat)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-SocketAgentSystemTask $name (New-SocketAgentTaskAction $batch) $triggers $settings
    Grant-SocketAgentTaskOwnerAccess $name
    Grant-SocketAgentTaskStartAccess $name
    Initialize-SocketAgentMachineFolder
    Add-SocketAgentFirewallRules $Port $NodeExe
    Start-ScheduledTask -TaskName $name
    "Registered and started $name"
}
