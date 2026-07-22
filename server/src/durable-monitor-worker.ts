import * as fs from "fs";
import { spawn } from "child_process";
import {
  getDurableMonitorRecord,
  updateDurableMonitorRecord,
} from "./durable-monitor-store";

const taskId = process.argv[2] || "";
const record = getDurableMonitorRecord(taskId);
if (!record) process.exit(2);

const outputFd = fs.openSync(record.outputFile, "a");
let child: ReturnType<typeof spawn> | null = null;

function appendLine(text: string): void {
  try { fs.writeSync(outputFd, `${text}\n`); } catch {}
}

function terminateChild(force = false): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

try {
  child = spawn(record.command, [], {
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", outputFd, outputFd],
    cwd: record.cwd,
    windowsHide: true,
  });
  updateDurableMonitorRecord(taskId, {
    workerPid: process.pid,
    processPid: child.pid,
    status: "running",
  });

  child.once("error", (error) => {
    appendLine(`[SocketAgent monitor failed to start: ${error.message}]`);
    updateDurableMonitorRecord(taskId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: null,
      exitSignal: null,
    });
    try { fs.closeSync(outputFd); } catch {}
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    appendLine(`Process exited with code ${code ?? "unknown"} (signal: ${signal || "none"})`);
    updateDurableMonitorRecord(taskId, {
      status: code === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: code,
      exitSignal: signal,
    });
    try { fs.closeSync(outputFd); } catch {}
    process.exit(code === 0 ? 0 : 1);
  });
} catch (error: any) {
  appendLine(`[SocketAgent monitor failed to start: ${error?.message || String(error)}]`);
  updateDurableMonitorRecord(taskId, {
    status: "failed",
    completedAt: new Date().toISOString(),
    exitCode: null,
    exitSignal: null,
  });
  try { fs.closeSync(outputFd); } catch {}
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    terminateChild(false);
    setTimeout(() => terminateChild(true), 750).unref?.();
  });
}
