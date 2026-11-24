# Shows or removes the toast that asks the owner to start pairing over when
# nobody can connect to this computer. See src/pairing-repair-toast.ts.
#
#   pairing-repair-toast.ps1 -Action show -NodePath <node.exe>
#   pairing-repair-toast.ps1 -Action remove
#
# Repair now opens socketagent-repair:, a per-user protocol that runs
# repair-pairing.cmd. The protocol exists only while the toast does.
param(
    [Parameter(Mandatory = $true)][ValidateSet("show", "remove")][string]$Action,
    [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
$appId = "SocketAgent.Server"
$tag = "pairing-repair"
$group = "socketagent"
$protocolKey = "HKCU:\Software\Classes\socketagent-repair"

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

if ($Action -eq "remove") {
    [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, $group, $appId)
    if (Test-Path $protocolKey) { Remove-Item -Path $protocolKey -Recurse -Force }
    exit 0
}

if (-not $NodePath) { throw "-NodePath is required to show the toast" }

# A toast needs a registered app ID. This per-user one needs no Start menu shortcut.
$appKey = "HKCU:\Software\Classes\AppUserModelId\$appId"
New-Item -Path $appKey -Force | Out-Null
Set-ItemProperty -Path $appKey -Name "DisplayName" -Value "SocketAgent"

$repairCmd = Join-Path $PSScriptRoot "repair-pairing.cmd"
New-Item -Path "$protocolKey\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $protocolKey -Name "(default)" -Value "URL:SocketAgent repair"
Set-ItemProperty -Path $protocolKey -Name "URL Protocol" -Value ""
# cmd /k drops the outer quotes and keeps the window open for the new code.
Set-ItemProperty -Path "$protocolKey\shell\open\command" -Name "(default)" -Value "cmd.exe /k `"`"$repairCmd`" `"$NodePath`"`""

# scenario="reminder" keeps the toast on screen until a button is pressed.
$toastXml = @"
<toast scenario="reminder" activationType="protocol" launch="socketagent-repair:">
  <visual>
    <binding template="ToastGeneric">
      <text>SocketAgent can't accept connections</text>
      <text>Its pairing file is damaged. Phones and other computers can't connect to this computer until you repair it.</text>
    </binding>
  </visual>
  <actions>
    <action content="Repair now" activationType="protocol" arguments="socketagent-repair:" />
    <action content="Later" activationType="system" arguments="dismiss" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($toastXml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = $tag
$toast.Group = $group
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
