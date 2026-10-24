import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { errorMessage } from "./value-guards";
import { logWindowsService, MACHINE_FOLDER, OWNER_TASKS, runPowerShell, SERVICE_TASK } from "./windows-machine-service";
import { sameWindowsPath } from "./windows-service-config";

// Repairs what commit 384e156 left behind. For three minutes on 2026-10-24 it
// moved every Windows machine install to %ProgramData%\SocketAgent\socketagent
// and died partway on each: it had copied the checkout, the agent CLIs and the
// browser runtime there, pointed both tasks at the copy and tightened
// SocketAgentService's ACL, but never handed the running server over or
// retired the old folder. The revert, 3604507, left those machines as they
// were. The serving server runs this once it is up:
//
//   - Tasks that run the copy's wrapper go back to the checkout the copy came
//     from, named in the copy's server\windows-service\moved-from.txt.
//   - A server running from the copy (a task started it there) moves its
//     wrapper loop back to the original once it is idle, as the move meant to
//     do forwards, and the next start deletes the copy.
//   - The copy, the staging folder, the toolchain and the browser runtime
//     under %ProgramData%\SocketAgent go once nothing runs from them.
//   - install-location.txt, which the desktop app reads, names the original.
//
// It changes nothing it cannot account for and reports that in the computer
// warnings. An install the move never touched is left alone, without running
// PowerShell. Delete this once every install has run it.

const win = path.win32;

export const REPAIR_TASKS = [...OWNER_TASKS, SERVICE_TASK] as const;
export type RepairTaskName = typeof REPAIR_TASKS[number];

const SYSTEM_SID = "S-1-5-18";

const TaskActionSchema = z.object({ execute: z.string(), arguments: z.string(), actions: z.number(), state: z.string() });
const MachineProcessSchema = z.object({ pid: z.number(), name: z.string(), sid: z.string(), commandLine: z.string() });
export type TaskAction = z.infer<typeof TaskActionSchema>;
export type MachineProcess = z.infer<typeof MachineProcessSchema>;
const InspectionSchema = z.object({
  tasks: z.object({ SocketAgent: TaskActionSchema.optional(), SocketClaude: TaskActionSchema.optional(), SocketAgentService: TaskActionSchema.optional() }),
  // ConvertTo-Json writes one process as an object and none as null.
  processes: z.union([
    z.array(MachineProcessSchema),
    MachineProcessSchema.transform((process) => [process]),
    z.null().transform((): MachineProcess[] => []),
  ]).optional().transform((processes) => processes ?? []),
});
export interface InstallRepairInspection {
  tasks: Partial<Record<RepairTaskName, TaskAction>>;
  /** Processes whose command line names anything under %ProgramData%\SocketAgent, this server excepted. */
  processes: MachineProcess[];
}

/** What the repair reads and changes. The real one is below; tests fake it. */
export interface InstallRepairHost {
  exists(file: string): boolean;
  readText(file: string): string | undefined;
  writeText(file: string, text: string): void;
  modifiedAt(file: string): number | undefined;
  copyFile(from: string, to: string): void;
  /** Deletes a folder whole. Throws, leaving it in place, when something holds a file in it. */
  removeDir(dir: string): void;
  inspect(): Promise<InstallRepairInspection>;
  /** Points the tasks that run previousServerDir's wrapper at serverDir's, through the owner's launcher. */
  pointTasks(serverDir: string, previousServerDir: string): Promise<void>;
  /** Ends SocketAgentService and starts it again from its current action. */
  restartServiceTask(): Promise<void>;
  /** Why this server must not restart now, or null while it is idle. */
  idleBlocker(): string | null;
  /** Arms the restart guard. Rewrites this server's wrapper to its canonical form on the way. */
  armRecoveryGuard(): boolean;
  /** Ends this server so its wrapper loop continues. */
  exit(): void;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface InstallRepairContext {
  /** This server's server folder and checkout. */
  serverDir: string;
  repoRoot: string;
  /** %ProgramData%\SocketAgent. */
  machineRoot: string;
  /** The owner's local app data, from windows-service.json. */
  localAppData: string;
  /** True when this server runs as SYSTEM. */
  service: boolean;
}

export type InstallRepairResult =
  | { status: "untouched" }
  | { status: "repaired" }
  /** The wrapper is moving back to the original checkout; this server is exiting. */
  | { status: "restarting" }
  /** Working, but something is left for the next start, such as a folder a running launcher holds. */
  | { status: "pending"; reason: string }
  /** Needs a person; shown in the computer warnings. */
  | { status: "blocked"; warning: string };

const BOM = /^﻿/;

function readTrimmed(host: InstallRepairHost, file: string): string | undefined {
  const text = host.readText(file)?.replace(BOM, "").trim();
  return text || undefined;
}

/** True when the command line names dir itself or something inside it. */
export function commandLineUses(commandLine: string, dir: string): boolean {
  const normalized = commandLine.replace(/\//g, "\\").toLowerCase();
  const target = dir.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  let from = 0;
  for (;;) {
    const at = normalized.indexOf(target, from);
    if (at < 0) return false;
    const next = normalized[at + target.length];
    if (next === undefined || next === "\\" || next === '"' || next === " " || next === "'") return true;
    from = at + 1;
  }
}

function tasksRunning(inspection: InstallRepairInspection, batFile: string): RepairTaskName[] {
  return REPAIR_TASKS.filter((name) => {
    const action = inspection.tasks[name];
    return action !== undefined && commandLineUses(action.arguments, batFile);
  });
}

/** A checkout with everything its wrapper needs to serve again. */
function checkoutComplete(host: InstallRepairHost, repoRoot: string): boolean {
  return [
    win.join(repoRoot, ".git"),
    win.join(repoRoot, "server", "package.json"),
    win.join(repoRoot, "server", ".env"),
    win.join(repoRoot, "server", "windows-service.json"),
    win.join(repoRoot, "server", "run-service.bat"),
    win.join(repoRoot, "server", "node_modules"),
  ].every((file) => host.exists(file));
}

/**
 * The running wrapper continues in another wrapper at its next pass. Each
 * pass calls :arm_recovery first, and cmd resumes a batch file by byte offset,
 * so nothing above that label changes; the jump goes in right after it and
 * the target at the end. Returns undefined when the wrapper has no such label.
 *
 * The target runs through call. Run bare from inside a called label, cmd
 * swaps the file but looks the same label up in the new one and carries on
 * from there, so the target's own loop never starts. The target's loop never
 * returns; if it ever does, this cmd ends and the task starts the target
 * itself, since the tasks name it by then.
 */
export function wrapperWithHandoff(batText: string, targetBat: string): string | undefined {
  const eol = batText.includes("\r\n") ? "\r\n" : "\n";
  const lines = batText.split(/\r?\n/);
  const at = lines.indexOf(":arm_recovery");
  if (at < 0) return undefined;
  const target = targetBat.replace(/"/g, "");
  const jump = `if exist "${target}" goto moved`;
  if (lines[at + 1] === jump) return batText;
  lines.splice(at + 1, 0, jump);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(
    "",
    ":moved",
    `echo [startup] SocketAgent continues in ${target} >> "%LOG_FILE%" 2>&1`,
    `call "${target}"`,
    `echo [startup] ${target} returned (%ERRORLEVEL%); this wrapper ends for the task to start it. >> "%LOG_FILE%" 2>&1`,
    "exit 1",
    "",
  );
  return lines.join(eol);
}

/** A handoff is tried once per this long; one that bounces back must not restart the copy every half minute. */
const HANDOFF_RETRY_MS = 10 * 60_000;

async function sleepUntilIdle(host: InstallRepairHost, why: string): Promise<void> {
  let announced = false;
  for (;;) {
    const blocker = host.idleBlocker();
    if (!blocker) return;
    if (!announced) host.log(`Waiting to ${why}: ${blocker}`);
    announced = true;
    await host.sleep(30_000);
  }
}

/**
 * SocketAgentService standing by from the copy, as it does after a start
 * there while the owner serves, is ended and started again so it stands by
 * from the checkout its task now names. Only SYSTEM's processes count: the
 * owner's server running from the copy has its own wrapper there. A SYSTEM
 * server owns that task itself and leaves it alone.
 */
async function settleServiceTask(host: InstallRepairHost, ctx: InstallRepairContext, inspection: InstallRepairInspection, copyRoot: string): Promise<InstallRepairInspection> {
  if (ctx.service) return inspection;
  const system = inspection.processes.filter((process) => process.sid === SYSTEM_SID && commandLineUses(process.commandLine, copyRoot));
  if (system.length === 0) return inspection;
  const describe = system.map((process) => `${process.pid} ${process.name}`).join(", ");
  if (system.some((process) => /dist[\\/]index\.js/i.test(process.commandLine))) {
    host.log(`A SYSTEM server still runs from ${copyRoot} (${describe}); leaving it`);
    return inspection;
  }
  host.log(`${SERVICE_TASK} stands by from ${copyRoot} (${describe}); restarting it from its repaired task`);
  await host.restartServiceTask();
  return host.inspect();
}

/** Deletes each folder nothing runs from. Returns what stayed and why. */
function removeLeftovers(host: InstallRepairHost, inspection: InstallRepairInspection, dirs: string[]): string[] {
  const kept: string[] = [];
  for (const dir of dirs) {
    if (!host.exists(dir)) continue;
    const users = inspection.processes.filter((process) => commandLineUses(process.commandLine, dir));
    if (users.length) {
      kept.push(`${dir} is in use (${users.map((process) => `${process.pid} ${process.name}`).join(", ")})`);
      continue;
    }
    try {
      host.removeDir(dir);
      host.log(`Removed ${dir}`);
    } catch (error: unknown) {
      kept.push(`${dir} could not be removed: ${errorMessage(error)}`);
    }
  }
  return kept;
}

export async function repairInterruptedMove(host: InstallRepairHost, ctx: InstallRepairContext): Promise<InstallRepairResult> {
  const copyRoot = win.join(ctx.machineRoot, "socketagent");
  const copyServer = win.join(copyRoot, "server");
  const copyBat = win.join(copyServer, "run-service.bat");
  const leftovers = [`${copyRoot}.copying`, win.join(ctx.machineRoot, "toolchains"), win.join(ctx.machineRoot, "browser-runtime")];
  const location = win.join(ctx.localAppData, "SocketAgent", "install-location.txt");
  const runningFromCopy = sameWindowsPath(ctx.repoRoot, copyRoot);
  const locationText = readTrimmed(host, location);
  const locationAtCopy = locationText !== undefined && sameWindowsPath(locationText, copyRoot);
  if (!runningFromCopy && !host.exists(copyRoot) && !leftovers.some((dir) => host.exists(dir)) && !locationAtCopy) {
    return { status: "untouched" };
  }
  const movedFrom = readTrimmed(host, win.join(copyServer, "windows-service", "moved-from.txt"));

  // Where the install belongs: this checkout, or the one the copy came from.
  let home = ctx.repoRoot;
  if (runningFromCopy) {
    if (!movedFrom || sameWindowsPath(movedFrom, copyRoot) || !checkoutComplete(host, movedFrom)) {
      const original = movedFrom ? `The install it was copied from, ${movedFrom}, is missing or incomplete` : "It does not record where it was copied from";
      return { status: "blocked", warning: `SocketAgent runs from ${copyRoot}, where an interrupted update left it. ${original}, so it cannot move back by itself. Run setup again.` };
    }
    home = movedFrom;
  }
  const homeServer = win.join(home, "server");

  let inspection = await host.inspect();
  const atCopy = tasksRunning(inspection, copyBat);
  if (atCopy.length) {
    // Only a copy of this checkout is this checkout's to take back. A copy
    // that is gone ran nothing; its tasks start the only install left.
    if (!runningFromCopy && host.exists(copyRoot) && (!movedFrom || !sameWindowsPath(movedFrom, ctx.repoRoot))) {
      return { status: "blocked", warning: `${atCopy.join(" and ")} run ${copyRoot}, left by an interrupted update, which was copied from ${movedFrom || "an unknown install"} rather than from ${ctx.repoRoot}. Run setup again.` };
    }
    host.log(`Pointing ${atCopy.join(" and ")} back at ${homeServer}`);
    await host.pointTasks(homeServer, copyServer);
    inspection = await host.inspect();
    const still = tasksRunning(inspection, copyBat);
    if (still.length) {
      return { status: "blocked", warning: `Could not point ${still.join(" and ")} back at ${home}; it still runs ${copyRoot}, left by an interrupted update. Rerun setup as an administrator.` };
    }
  }
  if (locationAtCopy) {
    host.writeText(location, home);
    host.log(`${location} names ${home} again`);
  }
  inspection = await settleServiceTask(host, ctx, inspection, copyRoot);

  if (runningFromCopy) {
    await sleepUntilIdle(host, `move back to ${home}`);
    // Settings saved since the copy was made.
    const envHere = win.join(ctx.serverDir, ".env");
    const envHome = win.join(homeServer, ".env");
    if ((host.modifiedAt(envHere) ?? 0) > (host.modifiedAt(envHome) ?? 0)) {
      host.copyFile(envHere, envHome);
      host.log(`Copied ${envHere} to ${envHome}, which was older`);
    }
    const attempted = win.join(ctx.serverDir, "windows-service", "moved-back-at.txt");
    const lastAttempt = Date.parse(readTrimmed(host, attempted) ?? "");
    if (Date.now() - lastAttempt < HANDOFF_RETRY_MS) {
      return { status: "pending", reason: `the wrapper was handed over to ${home} at ${new Date(lastAttempt).toISOString()} but this server started from ${copyRoot} again; trying again later, and the next task start runs ${home}` };
    }
    if (!host.armRecoveryGuard()) return { status: "pending", reason: "the restart guard could not be armed; moving back at the next restart" };
    const current = host.readText(copyBat);
    const handoff = current === undefined ? undefined : wrapperWithHandoff(current, win.join(homeServer, "run-service.bat"));
    if (!handoff) return { status: "pending", reason: `${copyBat} has no :arm_recovery to hand over from; the next task start runs ${home}` };
    host.writeText(attempted, new Date().toISOString());
    host.writeText(copyBat, handoff);
    host.log(`Moving back to ${home}; the wrapper continues there once this server exits`);
    host.exit();
    return { status: "restarting" };
  }

  const kept = removeLeftovers(host, inspection, [copyRoot, ...leftovers]);
  if (kept.length) {
    const reason = kept.join("; ");
    host.log(`Left for the next start: ${reason}`);
    return { status: "pending", reason };
  }
  return { status: "repaired" };
}

function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Renames the folder first, which Windows refuses while any file in it is open, so a held folder stays whole. */
function removeDirWhole(dir: string): void {
  const removing = `${dir}.removing`;
  if (fs.existsSync(removing)) fs.rmSync(removing, { recursive: true, force: true, maxRetries: 3 });
  fs.renameSync(dir, removing);
  fs.rmSync(removing, { recursive: true, force: true, maxRetries: 3 });
}

export interface InstallRepairOptions {
  repoRoot: string;
  localAppData: string;
  service: boolean;
  idleBlocker: () => string | null;
  armRecoveryGuard: () => boolean;
  exit: () => void;
}

/** Runs the repair for this server through PowerShell and the file system. */
export async function runInstallRepair(serverDir: string, options: InstallRepairOptions): Promise<InstallRepairResult> {
  const log = (message: string) => logWindowsService(serverDir, `Install repair: ${message}`);
  const powershell = async (args: string[], timeoutMs: number): Promise<string> => {
    const result = await runPowerShell(serverDir, "repair-windows-install.ps1", args, timeoutMs);
    if (!result.ok) throw new Error(result.output || "PowerShell failed");
    return result.output;
  };
  const host: InstallRepairHost = {
    exists: (file) => fs.existsSync(file),
    readText: readTextIfExists,
    writeText: (file, text) => fs.writeFileSync(file, text, "utf8"),
    modifiedAt: (file) => {
      try { return fs.statSync(file).mtimeMs; } catch { return undefined; }
    },
    copyFile: (from, to) => fs.copyFileSync(from, to),
    removeDir: removeDirWhole,
    inspect: async () => {
      const output = await powershell(["-Inspect", "-MachineRoot", MACHINE_FOLDER, "-ExcludePid", String(process.pid)], 60_000);
      const start = output.indexOf("{");
      return InspectionSchema.parse(JSON.parse(start < 0 ? output : output.slice(start)));
    },
    pointTasks: async (target, previous) => {
      const output = await powershell(["-PointTasks", "-ServerDirectory", target, "-PreviousServerDirectory", previous], 120_000);
      if (output) log(output);
    },
    restartServiceTask: async () => { await powershell(["-RestartServiceTask"], 60_000); },
    idleBlocker: options.idleBlocker,
    armRecoveryGuard: options.armRecoveryGuard,
    exit: options.exit,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  };
  const context: InstallRepairContext = {
    serverDir,
    repoRoot: options.repoRoot,
    machineRoot: MACHINE_FOLDER,
    localAppData: options.localAppData,
    service: options.service,
  };
  try {
    const result = await repairInterruptedMove(host, context);
    if (result.status === "blocked") log(`Needs a person: ${result.warning}`);
    else if (result.status !== "untouched") log(`Result: ${result.status}`);
    return result;
  } catch (error: unknown) {
    const warning = `Could not repair this install after an interrupted update: ${errorMessage(error)}`;
    log(warning);
    return { status: "blocked", warning };
  }
}
