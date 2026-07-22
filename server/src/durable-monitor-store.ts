import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { socketAgentDataPath } from "./socket-agent-paths";

export type DurableMonitorStatus = "starting" | "running" | "completed" | "failed";

export interface DurableMonitorRecord {
  taskId: string;
  sessionId: string;
  backend: "claude" | "codex";
  cwd: string;
  command: string;
  description: string;
  outputFile: string;
  createdAt: string;
  timeoutAt?: string;
  status: DurableMonitorStatus;
  workerPid?: number;
  processPid?: number;
  phoneOffset: number;
  agentOffset: number;
  completedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  launcher?: "systemd" | "launchd" | "detached";
}

const MONITOR_DIR = socketAgentDataPath("monitors");
const RECORD_DIR = path.join(MONITOR_DIR, "records");
const OUTPUT_DIR = path.join(MONITOR_DIR, "output");

function ensureMonitorDirs(): void {
  fs.mkdirSync(RECORD_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
}

function safeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

export function durableMonitorRecordPath(taskId: string): string {
  ensureMonitorDirs();
  return path.join(RECORD_DIR, `${safeTaskId(taskId)}.json`);
}

export function durableMonitorOutputPath(taskId: string): string {
  ensureMonitorDirs();
  return path.join(OUTPUT_DIR, `${safeTaskId(taskId)}.log`);
}

function atomicWrite(filePath: string, value: unknown): void {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withRecordLock<T>(taskId: string, operation: () => T): T {
  const lockPath = `${durableMonitorRecordPath(taskId)}.lock`;
  let lockFd: number | null = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(lockFd, String(process.pid), "utf8");
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        const ownerPid = Number(fs.readFileSync(lockPath, "utf8"));
        let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
        if (ownerAlive) {
          try { process.kill(ownerPid, 0); } catch { ownerAlive = false; }
        }
        if (!ownerAlive || age > 30_000) fs.unlinkSync(lockPath);
      } catch {}
      sleepSync(5);
    }
  }
  if (lockFd === null) throw new Error(`Timed out locking monitor record ${taskId}`);
  try {
    return operation();
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function saveDurableMonitorRecordUnlocked(record: DurableMonitorRecord): DurableMonitorRecord {
  ensureMonitorDirs();
  atomicWrite(durableMonitorRecordPath(record.taskId), record);
  return record;
}

export function saveDurableMonitorRecord(record: DurableMonitorRecord): DurableMonitorRecord {
  return withRecordLock(record.taskId, () => saveDurableMonitorRecordUnlocked(record));
}

export function getDurableMonitorRecord(taskId: string): DurableMonitorRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(durableMonitorRecordPath(taskId), "utf8"));
    if (!parsed || parsed.taskId !== taskId || typeof parsed.sessionId !== "string") return null;
    return parsed as DurableMonitorRecord;
  } catch {
    return null;
  }
}

export function updateDurableMonitorRecord(
  taskId: string,
  patch: Partial<DurableMonitorRecord>,
): DurableMonitorRecord | null {
  return withRecordLock(taskId, () => {
    const current = getDurableMonitorRecord(taskId);
    if (!current) return null;
    return saveDurableMonitorRecordUnlocked({ ...current, ...patch, taskId: current.taskId });
  });
}

export function listDurableMonitorRecords(): DurableMonitorRecord[] {
  ensureMonitorDirs();
  const records: DurableMonitorRecord[] = [];
  for (const file of fs.readdirSync(RECORD_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(RECORD_DIR, file), "utf8"));
      if (parsed && typeof parsed.taskId === "string" && typeof parsed.sessionId === "string") {
        records.push(parsed as DurableMonitorRecord);
      }
    } catch {}
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function removeDurableMonitorRecord(taskId: string): void {
  withRecordLock(taskId, () => {
    try { fs.unlinkSync(durableMonitorRecordPath(taskId)); } catch {}
  });
}

export function createDurableMonitorRecord(input: {
  taskId: string;
  sessionId: string;
  backend: "claude" | "codex";
  cwd: string;
  command: string;
  description: string;
  timeoutSeconds?: number;
}): DurableMonitorRecord {
  const outputFile = durableMonitorOutputPath(input.taskId);
  fs.writeFileSync(outputFile, "", { encoding: "utf8", mode: 0o600 });
  const now = Date.now();
  return saveDurableMonitorRecord({
    ...input,
    outputFile,
    createdAt: new Date(now).toISOString(),
    ...(input.timeoutSeconds
      ? { timeoutAt: new Date(now + input.timeoutSeconds * 1000).toISOString() }
      : {}),
    status: "starting",
    phoneOffset: 0,
    agentOffset: 0,
  });
}

function workerPath(): string {
  return path.join(__dirname, "durable-monitor-worker.js");
}

function launchDetached(record: DurableMonitorRecord): DurableMonitorRecord {
  const marked = updateDurableMonitorRecord(record.taskId, { launcher: "detached" }) || record;
  const child = spawn(process.execPath, [workerPath(), record.taskId], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return getDurableMonitorRecord(record.taskId) || { ...marked, workerPid: child.pid };
}

export function launchDurableMonitor(record: DurableMonitorRecord): DurableMonitorRecord {
  const forceDirect = process.env.SOCKETAGENT_MONITOR_LAUNCH_MODE === "direct";
  if (!forceDirect && process.platform === "linux") {
    updateDurableMonitorRecord(record.taskId, { launcher: "systemd" });
    const unit = `socketagent-monitor-${safeTaskId(record.taskId)}`;
    const result = spawnSync("systemd-run", [
      "--user",
      "--unit", unit,
      "--collect",
      "--quiet",
      `--setenv=SOCKETAGENT_DATA_DIR=${socketAgentDataPath()}`,
      process.execPath,
      workerPath(),
      record.taskId,
    ], { stdio: "ignore", windowsHide: true });
    if (result.status === 0) {
      return getDurableMonitorRecord(record.taskId) || { ...record, launcher: "systemd" };
    }
  }
  if (!forceDirect && process.platform === "darwin") {
    updateDurableMonitorRecord(record.taskId, { launcher: "launchd" });
    const label = `com.socketagent.monitor.${safeTaskId(record.taskId)}`;
    const result = spawnSync("launchctl", [
      "submit", "-l", label, "--", "/usr/bin/env",
      `SOCKETAGENT_DATA_DIR=${socketAgentDataPath()}`,
      process.execPath, workerPath(), record.taskId,
    ], { stdio: "ignore" });
    if (result.status === 0) {
      return getDurableMonitorRecord(record.taskId) || { ...record, launcher: "launchd" };
    }
  }
  return launchDetached(record);
}

function killPid(pid: number, force: boolean, processTree: boolean): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), ...(processTree ? ["/t"] : []), ...(force ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(processTree ? -pid : pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

/** Remove durable ownership and optionally terminate the monitored command. */
export function stopDurableMonitor(taskId: string, killProcess: boolean): DurableMonitorRecord | null {
  const record = getDurableMonitorRecord(taskId);
  if (!record) return null;
  // Remove first so a racing worker exit cannot recreate or complete ownership.
  removeDurableMonitorRecord(taskId);
  if (killProcess && record.processPid) {
    killPid(record.processPid, false, process.platform !== "win32");
    setTimeout(() => killPid(record.processPid!, true, process.platform !== "win32"), 750).unref?.();
  }
  if (killProcess && record.workerPid) {
    setTimeout(() => killPid(record.workerPid!, true, false), 1_000).unref?.();
  }
  return record;
}

function pidIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopDurableMonitorAndWait(
  taskId: string,
  killProcess: boolean,
): Promise<DurableMonitorRecord | null> {
  const record = stopDurableMonitor(taskId, killProcess);
  if (!record || !killProcess || !record.processPid) return record;
  const deadline = Date.now() + 2_000;
  while (pidIsAlive(record.processPid) && Date.now() < deadline) {
    if (Date.now() + 800 >= deadline) {
      killPid(record.processPid, true, process.platform !== "win32");
      if (record.workerPid) killPid(record.workerPid, true, false);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (pidIsAlive(record.processPid)) {
    throw new Error(`Monitor process tree ${record.processPid} did not exit after SIGKILL`);
  }
  return record;
}

export function readDurableMonitorSlice(
  record: DurableMonitorRecord,
  start: number,
): { content: string; end: number } {
  try {
    const stat = fs.statSync(record.outputFile);
    if (stat.size <= start) return { content: "", end: start };
    const fd = fs.openSync(record.outputFile, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return { content: buffer.toString("utf8"), end: stat.size };
  } catch {
    return { content: "", end: start };
  }
}

export function durableMonitorProcessIsAlive(record: DurableMonitorRecord): boolean {
  if (record.status === "completed" || record.status === "failed") return false;
  const pid = record.workerPid || record.processPid;
  if (!pid) return record.status === "starting";
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
