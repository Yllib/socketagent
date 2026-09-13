# Windows installer validation

Run the Windows checks in disposable lab VMs, one VM at a time. Use a local
candidate repository so testing does not require publishing server changes.
Disable automatic updates in the test VM while testing that candidate.

After installation, open PowerShell in the VM:

```powershell
$checkout = 'C:\SocketAgent Test\server checkout'
& "$checkout\server\test\windows-install-smoke.ps1" -Checkout $checkout
& "$checkout\server\test\windows-service-lifecycle.ps1" -Checkout $checkout -DisposableVm
```

The smoke check verifies authenticated readiness, the interactive hidden launcher,
Claude/Codex/SocketAgent commands under Restricted execution policy, child
exit-code propagation, and cleanup when the legacy CMD parent is killed. The
lifecycle test stops the server. It verifies that a
legacy task action migrates without interrupting the current process or changing
the task's principal, triggers, or settings. It also verifies migration on server
startup, crash recovery, process cleanup after stopping the task, and recovery
through the separate scheduled guard.

For each supported Windows version, also verify:

- A fresh install, including a destination containing spaces.
- Reinstallation without a destination override, preserving the selected folder,
  configuration, and relay keys.
- Reinstallation with the task named `SocketClaude`, preserving that name and
  verifying that setup does not create a competing `SocketAgent` task.
- Reboot followed by login, then the smoke check again.
- An old task with an all-users logon trigger. If Windows denies changing its
  action without elevation, the updated batch file must start the native launcher,
  hide the owning console, and keep the scheduled task running.
- Claude auth status and Codex app-server initialization, account lookup, and
  thread creation through the launcher. Authenticated turns need test accounts.
- Browser component installation and a live frame from a headed browser.
  Run this through the installed SocketAgent task. An elevated diagnostic shell
  can make Chrome hand off to a normal-user process and exit its original parent.

New tasks use a logon trigger scoped to the owning user. This matters because a
non-elevated server cannot update an all-users trigger, even when its task DACL
allows writes. The installer grants the owning user access to the Limited task;
updates preserve the existing task security descriptor. Older protected tasks
use the batch fallback until an elevated installer run can replace their action.

Local automated checks: `npm test --prefix server`.

Install and restart readiness checks allow up to three minutes. In the Windows 11
lab, background Windows Update and Defender activity pushed some successful
starts beyond one minute. The check still requires an authenticated response
from SocketAgent; a running task or unrelated listener does not count.

## Results recorded on 2026-09-06

Local server suite: 371 passed, no failures or skipped tests.

| Check | Windows 10 Enterprise LTSC, build 19044 | Windows 11 Enterprise, build 26200 |
| --- | --- | --- |
| Fresh install | Passed, custom folder containing spaces | Passed, default folder |
| Reinstall without a folder override | Passed, configuration and pairing hashes unchanged | Passed, configuration and pairing hashes unchanged |
| Reboot and login startup | Passed, server and launcher had no visible window | Passed, server and launcher had no visible window |
| Migration preserves running PID and task settings | Passed | Passed |
| Crash, task-stop, and scheduled recovery | Passed | Passed |
| Protected old task hides its console and stops its server | Passed | Passed |
| Restricted PowerShell commands and launcher exit code | Passed | Passed |
| Killing a legacy CMD parent cleans up its hidden child | Passed | Passed |
| Claude launch and Codex app-server initialization/thread creation | Passed | Passed |
| Browser installation and live frame through the installed task | Passed, 430x860 | Passed after Windows Update/reboot, 430x860 |
| Legacy `SocketClaude` name survives reinstall without a duplicate task | Passed | Not repeated |

The Windows 10 VM used Node 22.14.0; Windows 11 used Node 24.19.0. Both used
Claude Code 2.1.263 and Codex CLI 0.153.4. The VMs had no signed-in agent accounts,
so authenticated Claude/Codex turns remain untested. Windows 11's first browser
validation timed out during background OS updates; the installed task passed
browser installation and frame capture after reboot.

Tests used a temporary candidate repository on the isolated VM network. No source
repository changes were pushed or deployed. The disposable VMs were shut down
after validation; their sealed templates were preserved.
