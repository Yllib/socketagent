import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PosixProcessTree } from "./posix-process-tree";
import { errorMessage } from "./value-guards";

export const PEER_COMMAND_DEFAULT_TIMEOUT_S = 120;
export const PEER_COMMAND_MAX_TIMEOUT_S = 600;
export const PEER_COMMAND_OUTPUT_CAP = 64 * 1024;

export interface PeerCommandRequest {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}

export interface PeerCommandResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Resolves the working directory a linked computer asked for, defaulting to home. */
export function resolvePeerCommandCwd(cwd: string | undefined): string {
  const candidate = cwd?.trim() ? path.resolve(cwd.trim()) : os.homedir();
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`Working directory not found: ${candidate}`);
  }
  return candidate;
}

export function clampPeerCommandTimeout(seconds: number | undefined): number {
  if (seconds === undefined) return PEER_COMMAND_DEFAULT_TIMEOUT_S;
  if (!Number.isFinite(seconds) || seconds <= 0) return PEER_COMMAND_DEFAULT_TIMEOUT_S;
  return Math.min(PEER_COMMAND_MAX_TIMEOUT_S, Math.ceil(seconds));
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const shell = process.env.SOCKETAGENT_POWERSHELL || "powershell.exe";
    return { file: shell, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { file: "bash", args: ["-lc", command] };
}

class CappedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.bytes;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes += room;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs one command in the user's shell for a linked computer. On timeout the
 * whole process tree is killed, including children that detached from the
 * shell, so a runaway build cannot keep burning the target after the caller
 * gave up.
 */
export function runPeerCommand(request: PeerCommandRequest): Promise<PeerCommandResult> {
  const cwd = resolvePeerCommandCwd(request.cwd);
  const timeoutMs = clampPeerCommandTimeout(request.timeoutSeconds) * 1000;
  const { file, args } = shellInvocation(request.command);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = new CappedOutput(PEER_COMMAND_OUTPUT_CAP);
    const stderr = new CappedOutput(PEER_COMMAND_OUTPUT_CAP);
    let timedOut = false;
    let settled = false;
    const tree = process.platform === "win32" || !child.pid ? null : new PosixProcessTree(child.pid);

    const killTree = async (): Promise<void> => {
      if (!child.pid) return;
      if (tree) {
        await tree.stop("SIGTERM", 2_000);
        return;
      }
      await new Promise<void>((done) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("exit", () => done());
        killer.on("error", () => done());
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree().catch((err: unknown) => {
        console.warn(`[PeerCommand] Could not stop the process tree: ${errorMessage(err)}`);
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        ...(signal ? { signal } : {}),
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
      });
    });
  });
}
