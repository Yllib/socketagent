import { runPowerShell } from "./windows-machine-service";

/**
 * A Windows toast for when nobody can connect to this computer until pairing
 * starts over (see DeviceRegistry.problem). It stays on screen until the
 * owner acts on it. Repair now opens a console that explains the reset, waits
 * for a key, then runs `socketagent pair --reset` and shows the new code.
 *
 * The owner's server shows it at start and again every 3 hours, replacing the
 * last one, in case it was dismissed and forgotten. The SYSTEM server has no
 * desktop to show it on. pairing-repair-toast.ps1 does the work.
 */
const REMIND_EVERY_MS = 3 * 60 * 60 * 1000;

let reminder: ReturnType<typeof setInterval> | undefined;

function runToastScript(serverDir: string, args: string[]): void {
  void runPowerShell(serverDir, "pairing-repair-toast.ps1", args, 30_000).then((result) => {
    if (!result.ok) console.warn(`[Devices] Pairing repair toast ${args[1]} failed: ${result.output}`);
  });
}

export function startPairingRepairToast(serverDir: string): void {
  if (reminder) return;
  const show = () => runToastScript(serverDir, ["-Action", "show", "-NodePath", process.execPath]);
  show();
  reminder = setInterval(show, REMIND_EVERY_MS);
  reminder.unref();
}

/** Takes the toast down after pairing started over. */
export function stopPairingRepairToast(serverDir: string): void {
  if (!reminder) return;
  clearInterval(reminder);
  reminder = undefined;
  runToastScript(serverDir, ["-Action", "remove"]);
}
