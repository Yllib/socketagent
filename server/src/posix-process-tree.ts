import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  state: string;
  started: string;
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error.code === "ENOENT" || error.code === "ESRCH");
}

function readLinuxProcess(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parentheses. Fields after its final ')' start at state.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const started = fields[19];
    if (!state || !Number.isInteger(parentPid) || !started) {
      throw new Error(`Invalid process status for ${pid}`);
    }
    return { pid, parentPid, state, started };
  } catch (error) {
    if (isGone(error)) return undefined;
    throw error;
  }
}

function processSnapshot(): ProcessIdentity[] {
  if (process.platform === "linux") {
    const processes: ProcessIdentity[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const process = readLinuxProcess(Number(entry));
      if (process) processes.push(process);
    }
    return processes;
  }
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,lstart="], {
    encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return output.trim().split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("Invalid process table from ps");
    return { pid: Number(match[1]), parentPid: Number(match[2]), state: match[3], started: match[4] };
  });
}

function isSameLiveProcess(expected: ProcessIdentity, current: ProcessIdentity | undefined): boolean {
  return current !== undefined && current.started === expected.started
    && !/^[ZX]/.test(current.state);
}

/** Owns descendant identities across parent exit, including sandbox children that call setsid(). */
export class PosixProcessTree {
  private readonly members = new Map<number, ProcessIdentity>();

  constructor(private readonly rootPid: number) {
    const root = this.current(rootPid);
    if (root) this.members.set(rootPid, root);
  }

  private current(pid: number): ProcessIdentity | undefined {
    return process.platform === "linux"
      ? readLinuxProcess(pid)
      : processSnapshot().find((entry) => entry.pid === pid);
  }

  private signal(member: ProcessIdentity, signal: NodeJS.Signals): void {
    // Never signal a PID that has been recycled since we recorded ownership.
    if (!isSameLiveProcess(member, this.current(member.pid))) return;
    try {
      process.kill(member.pid, signal);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  private signalTree(signal: NodeJS.Signals): void {
    const frozen = new Map<number, ProcessIdentity>();
    const freeze = (member: ProcessIdentity) => {
      frozen.set(member.pid, member);
      this.signal(member, "SIGSTOP");
    };
    try {
      // Freeze parents before discovering descendants so commands cannot fork
      // past our snapshot while shutdown is in progress.
      for (const member of this.members.values()) freeze(member);
      const deadline = Date.now() + 2000;
      for (;;) {
        const snapshot = processSnapshot();
        const liveParents = new Set(snapshot.filter((entry) => {
          const owned = this.members.get(entry.pid);
          return owned && isSameLiveProcess(owned, entry);
        }).map((entry) => entry.pid));
        let added = false;
        for (const entry of snapshot) {
          if (this.members.has(entry.pid) || !liveParents.has(entry.parentPid)) continue;
          this.members.set(entry.pid, entry);
          freeze(entry);
          added = true;
        }
        if (!added) break;
        if (Date.now() >= deadline) throw new Error(`Could not stabilize process tree ${this.rootPid}`);
      }
      for (const member of [...this.members.values()].reverse()) this.signal(member, signal);
    } finally {
      // SIGTERM needs a resumed process to handle it. Also release every process
      // we froze if discovery/signalling failed so a retry remains possible.
      const resumeErrors: unknown[] = [];
      for (const member of frozen.values()) {
        try {
          this.signal(member, "SIGCONT");
        } catch (error) {
          resumeErrors.push(error);
        }
      }
      if (resumeErrors.length > 0) throw new AggregateError(resumeErrors, "Could not resume processes after shutdown signalling");
    }
  }

  async stop(signal: NodeJS.Signals, forceKillMs: number): Promise<void> {
    this.signalTree(signal);
    const forceAt = Date.now() + forceKillMs;
    const deadline = forceAt + 2000;
    let forced = signal === "SIGKILL";
    for (;;) {
      const live = [...this.members.values()].filter((member) =>
        isSameLiveProcess(member, this.current(member.pid)));
      if (live.length === 0) return;
      if (!forced && Date.now() >= forceAt) {
        this.signalTree("SIGKILL");
        forced = true;
      }
      if (Date.now() >= deadline) {
        throw new Error(`codex app-server process tree ${this.rootPid} did not exit after SIGKILL (${live.map((member) => member.pid).join(", ")})`);
      }
      await delay(25);
    }
  }
}
