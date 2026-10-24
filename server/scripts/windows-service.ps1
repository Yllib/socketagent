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

# A machine install compiles its launcher inside its own folder, which only
# administrators can write, because SocketAgentService runs it as SYSTEM. A
# limited install uses the owner's local app data. Matches windowsLauncherPath
# in src\windows-service-config.ts.
function Get-SocketAgentLauncher([string]$ServerDirectory = (Split-Path $PSScriptRoot -Parent)) {
    $source = Join-Path $ServerDirectory 'scripts\windows-launcher.cs'
    $hash = (Get-FileHash $source -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
    $directory = if (Test-SocketAgentMachineInstall (Split-Path $ServerDirectory -Parent)) {
        Join-Path $ServerDirectory 'windows-service\launchers'
    } else { Join-Path (Get-SocketAgentOwnerLocalAppData) 'SocketAgent\launchers' }
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
    $serverDirectory = Split-Path $BatchFile -Parent
    New-ScheduledTaskAction -Execute (Get-SocketAgentLauncher $serverDirectory) -Argument ('"' + $BatchFile + '"') -WorkingDirectory $serverDirectory
}

# Points this checkout's tasks at its current launcher. With
# $PreviousServerDirectory, also moves the tasks that run that checkout's
# wrapper over to this one.
function Update-SocketAgentTaskLauncher([string]$ServerDirectory, [string]$PreviousServerDirectory) {
    $batch = Join-Path $ServerDirectory 'run-service.bat'
    $directories = @($ServerDirectory) + @($PreviousServerDirectory | Where-Object { $_ })
    foreach ($name in @('SocketAgent', 'SocketClaude', 'SocketAgentService')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task -or $task.Actions.Count -ne 1) { continue }
        $action = $task.Actions[0]
        $exe = [IO.Path]::GetFileName($action.Execute)
        # Only migrate this checkout's known service action. Preserve custom tasks.
        $arguments = ([string]$action.Arguments).Trim()
        $knownBatch = $false
        $knownVbs = $false
        foreach ($directory in $directories) {
            $quotedBatch = '"' + (Join-Path $directory 'run-service.bat') + '"'
            if ($exe -ieq 'cmd.exe') {
                if ($arguments -match ('^(?:/[ds]\s+)*/c\s+"?' + [regex]::Escape($quotedBatch) + '"?\s*$')) { $knownBatch = $true }
            } elseif ($arguments -ieq $quotedBatch) { $knownBatch = $true }
            if ($exe -ieq 'wscript.exe' -and $arguments.Trim('"') -ieq (Join-Path $directory 'run-service-hidden.vbs')) { $knownVbs = $true }
        }
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

# SocketAgentService runs the checkout as SYSTEM, so a machine install keeps
# it here, where only SYSTEM and administrators can write. Locking a folder
# in the owner's profile is not enough: the owner may rename any folder in
# their profile and put another in its place.
function Get-SocketAgentMachineInstallDir {
    Join-Path (Join-Path $env:ProgramData 'SocketAgent') 'socketagent'
}

function Test-SocketAgentMachineInstall([string]$RepoRoot) {
    [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\') -ieq [IO.Path]::GetFullPath((Get-SocketAgentMachineInstallDir)).TrimEnd('\')
}

# Owned by Administrators; SYSTEM and administrators have full control and the
# install's owner may read and run it. Nobody else gets in, because server\.env
# holds AUTH_TOKEN. OWNER RIGHTS keeps whoever creates a file later from
# changing its permissions, since owning a file normally allows that.
function Protect-SocketAgentInstallFolder([string]$Directory, [string]$OwnerSid) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $entries = @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-3-4', 'ReadAndExecute'))
    if ($OwnerSid -and $OwnerSid -notin @('S-1-5-18', 'S-1-5-32-544')) { $entries += ,@($OwnerSid, 'ReadAndExecute') }
    foreach ($entry in $entries) {
        $sid = New-Object Security.Principal.SecurityIdentifier $entry[0]
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, $entry[1], $inherit, 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Directory -AclObject $acl
    # Files that already exist keep the owner that created them; make every
    # one inherit the rules above and belong to Administrators.
    & icacls.exe $Directory /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not take ownership of $Directory" }
    Get-ChildItem -LiteralPath $Directory -Force | ForEach-Object {
        & icacls.exe $_.FullName /reset /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not reset permissions under $Directory" }
    }
}

# The SID of the account whose profile is $ProfilePath.
function Get-SocketAgentProfileSid([string]$ProfilePath) {
    $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -and ([IO.Path]::GetFullPath($_.LocalPath).TrimEnd('\') -ieq [IO.Path]::GetFullPath($ProfilePath).TrimEnd('\')) } | Select-Object -First 1
    if (-not $profile) { throw "No Windows account has the profile $ProfilePath" }
    $profile.SID
}

# Copies a checkout, with its build, dependencies, .env and plugins, to
# $Destination, which must not exist yet. It fills a protected staging folder
# first and renames it, so $Destination never holds half a copy.
function Copy-SocketAgentInstall([string]$Source, [string]$Destination, [string]$OwnerSid) {
    if (Test-Path -LiteralPath $Destination) { throw "$Destination already exists" }
    $staging = "$Destination.copying"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Force $staging | Out-Null
    Protect-SocketAgentInstallFolder $staging $OwnerSid
    # The serving wrapper holds socketagent.log open, and the launcher is
    # rebuilt inside the new folder, so neither is copied.
    & robocopy.exe $Source $staging /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NP /NFL /NDL /NJH /NJS /XF socketagent.log /XD (Join-Path $Source 'server\windows-service\launchers') | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying $Source to $staging failed (robocopy exit $LASTEXITCODE)" }
    Protect-SocketAgentInstallFolder $staging $OwnerSid
    Rename-Item -LiteralPath $staging -NewName (Split-Path $Destination -Leaf)
}

# True when a SocketAgent task runs $ServerDirectory's wrapper.
function Test-SocketAgentTasksUse([string]$ServerDirectory) {
    $batch = Join-Path $ServerDirectory 'run-service.bat'
    foreach ($name in @('SocketAgent', 'SocketClaude', 'SocketAgentService')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task -and @($task.Actions | Where-Object { ([string]$_.Arguments).Contains($batch) }).Count) { return $true }
    }
    return $false
}

# Registers a task that runs as SYSTEM in Session 0.
function Register-SocketAgentSystemTask([string]$Name, $Action, $Trigger, $Settings) {
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $parameters = @{ TaskName = $Name; Action = $Action; Principal = $principal; Settings = $Settings; Force = $true }
    if ($Trigger) { $parameters.Trigger = $Trigger }
    Register-ScheduledTask @parameters | Out-Null
}

# C:\ProgramData\SocketAgent holds machine-server.json, which tells the
# desktop app under every account where this install answers and with which
# key; the server writes it. A machine install also keeps its checkout, agent
# CLIs and browser here. Only SYSTEM and administrators may write there,
# because ProgramData lets any user create files and the app trusts this one.
function Initialize-SocketAgentMachineFolder {
    $directory = Join-Path $env:ProgramData 'SocketAgent'
    # Any user may create this folder before setup does. One setup did not
    # make, and everything in it, is theirs, so it goes.
    if (Test-Path -LiteralPath $directory) {
        $owner = (Get-Acl -LiteralPath $directory).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) { Remove-Item -LiteralPath $directory -Recurse -Force }
    }
    New-Item -ItemType Directory -Force $directory | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    # OWNER RIGHTS: whoever creates a file here later may not change its
    # permissions, which owning a file otherwise allows.
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'), @('S-1-3-4', 'ReadAndExecute'))) {
        $sid = New-Object Security.Principal.SecurityIdentifier $entry[0]
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, $entry[1], $inherit, 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
}

# Only SYSTEM and administrators may change the SYSTEM task. Every signed-in
# account may see and start it, so the desktop app under any account can
# start the machine server; 0x1200a9 is FILE_GENERIC_READ | EXECUTE, which
# Task Scheduler reads as read and run. Replaces whatever else it allowed,
# including the full control earlier setups gave the owner.
function Set-SocketAgentServiceTaskAccess([string]$TaskName = 'SocketAgentService') {
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $scheduler.GetFolder('\').GetTask($TaskName).SetSecurityDescriptor('D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;AU)', 0)
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
    Initialize-SocketAgentMachineFolder
    Register-SocketAgentSystemTask $name (New-SocketAgentTaskAction $batch) $triggers $settings
    Set-SocketAgentServiceTaskAccess $name
    Add-SocketAgentFirewallRules $Port $NodeExe
    Start-ScheduledTask -TaskName $name
    "Registered and started $name"
}
