import { execFile, execFileSync } from "child_process";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { z } from "zod";
import { errorMessage } from "./value-guards";

// Every Windows install has two tasks that run the same run-service.bat:
//
//   SocketAgent (or SocketClaude)  the owner's elevated logon task. It serves
//                                  whenever the owner is signed in.
//   SocketAgentService             SYSTEM, at startup, at any logon and every
//                                  5 minutes. It serves while the owner is
//                                  signed out and waits otherwise.
//
// Before each server start the wrapper runs `windows-service-cli.js
// arbitrate`, which decides between them:
//
//   - Under SYSTEM it waits while the owner's copy is running. The owner's
//     wrapper holds socketagent.log open for its whole preflight and server
//     run, so a held log means the owner serves; while it is free, the owner's
//     task status says whether the owner is still signed in. A sign-out ends
//     every process in the owner's session, so SYSTEM picks up within seconds.
//   - Under the owner it asks a serving SYSTEM server to yield through
//     POST /internal/machine/yield, then waits for socketagent.log. A SYSTEM
//     server that does not let go is ended through its task.
//
// Neither copy starts anything as the other account. Task Scheduler starts
// both, and running turns move over through the restart recovery journal.
// Progress goes to server\windows-service\service.log, because the serving
// wrapper's redirect locks socketagent.log against every other writer.

export const SERVICE_TASK = "SocketAgentService";
export const OWNER_TASKS = ["SocketAgent", "SocketClaude"] as const;

const LOOPBACK = "127.0.0.1";

export function windowsServiceDir(serverDir: string): string {
  return path.join(serverDir, "windows-service");
}

/** Appends to the service log and echoes to stdout. */
export function logWindowsService(serverDir: string, message: string): void {
  console.log(`[Service] ${message}`);
  try {
    const dir = windowsServiceDir(serverDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "service.log"), `${new Date().toISOString()} [${process.pid}] ${message}\r\n`);
  } catch {}
}

function schtasks(args: string[]): boolean {
  try {
    execFileSync("schtasks.exe", args, { stdio: "ignore", timeout: 30_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function taskExists(name: string): boolean {
  return schtasks(["/Query", "/TN", name]);
}

/** The task's status column, such as Ready, Running or Disabled, or undefined when it is missing. */
function taskStatus(name: string): string | undefined {
  try {
    const csv = execFileSync("schtasks.exe", ["/Query", "/TN", name, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    return csv.trim().split(/\r?\n/)[0]?.split('","').at(-1)?.replace(/"$/, "");
  } catch {
    return undefined;
  }
}

function ownerTaskRunning(): boolean {
  return OWNER_TASKS.some((name) => taskStatus(name) === "Running");
}

/**
 * True while another wrapper has socketagent.log open, which it does from its
 * preflight update until its server exits. cmd opens a `>>` target without
 * write sharing, so this open fails then.
 */
export function serverLogHeld(serverDir: string): boolean {
  try {
    fs.closeSync(fs.openSync(path.join(serverDir, "socketagent.log"), "a"));
    return false;
  } catch (error: unknown) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}

function readEnv(serverDir: string): { port: number; token: string } {
  let values: Record<string, string> = {};
  try { values = dotenv.parse(fs.readFileSync(path.join(serverDir, ".env"))); } catch {}
  return { port: Number(values.PORT || 8085), token: values.AUTH_TOKEN || "" };
}

const MachineHealthSchema = z.object({ service: z.literal("socketagent"), ready: z.boolean(), system: z.boolean() });

function request(options: http.RequestOptions): Promise<{ status: number; body: string } | undefined> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: LOOPBACK, timeout: 3000, ...options }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/** True when a ready SYSTEM server answers on this port. */
async function systemServerServing(port: number): Promise<boolean> {
  const response = await request({ port, path: "/internal/machine/health", method: "GET" });
  if (response?.status !== 200) return false;
  try {
    const parsed = MachineHealthSchema.safeParse(JSON.parse(response.body));
    return parsed.success && parsed.data.ready && parsed.data.system;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** SYSTEM: returns once the owner's copy is neither serving nor about to. */
async function waitForOwnerToLeave(serverDir: string): Promise<void> {
  let announced = false;
  for (;;) {
    // The log check costs nothing; the task query runs only while it is free.
    if (!serverLogHeld(serverDir) && !ownerTaskRunning()) break;
    if (!announced) logWindowsService(serverDir, "Standing by: the owner's server is running");
    announced = true;
    await sleep(1000);
  }
  if (announced) logWindowsService(serverDir, "The owner's server stopped; serving as SYSTEM");
}

const YIELD_GRACE_MS = 60_000;
const OWNER_WAIT_LIMIT_MS = 10 * 60_000;

/** Owner: asks a serving SYSTEM server to stop, then waits for socketagent.log. */
async function takeOverFromSystem(serverDir: string): Promise<void> {
  if (!serverLogHeld(serverDir)) return;
  const { port, token } = readEnv(serverDir);
  const started = Date.now();
  let askedAt = 0;
  while (serverLogHeld(serverDir)) {
    const now = Date.now();
    if (!askedAt && await systemServerServing(port)) {
      const response = await request({ port, path: "/internal/machine/yield", method: "POST", headers: { Authorization: `Bearer ${token}` } });
      logWindowsService(serverDir, `Asked the SYSTEM server to hand over: ${response ? `HTTP ${response.status}` : "no answer"}`);
      askedAt = now;
    }
    if ((askedAt && now - askedAt > YIELD_GRACE_MS) || now - started > OWNER_WAIT_LIMIT_MS) {
      // Ending the task ends its wrapper too; the 5-minute trigger starts it
      // again, and it then waits for this copy.
      logWindowsService(serverDir, `${SERVICE_TASK} did not let go; ${schtasks(["/End", "/TN", SERVICE_TASK]) ? "ended it" : "could not end it"}`);
      for (let i = 0; i < 30 && serverLogHeld(serverDir); i++) await sleep(500);
      return;
    }
    await sleep(500);
  }
  logWindowsService(serverDir, "Took over from the SYSTEM server");
}

/** run-service.bat calls this before every start. It returns when this copy should serve. */
export async function arbitrate(serverDir: string, service: boolean): Promise<void> {
  if (service) await waitForOwnerToLeave(serverDir);
  else await takeOverFromSystem(serverDir);
}

function runPowerShell(serverDir: string, script: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(serverDir, "scripts", script), ...args], {
      cwd: serverDir, encoding: "utf8", timeout: timeoutMs, windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout || ""}${stderr || ""}`.trim() || (error ? errorMessage(error) : "") });
    });
  });
}

/**
 * One-time migration for installs from before SocketAgentService: the
 * owner's elevated server registers it once its wrapper is current. Delete
 * this once every install has run it.
 */
export async function addMachineServiceTask(serverDir: string, elevated: boolean | undefined): Promise<void> {
  if (taskExists(SERVICE_TASK)) return;
  if (elevated !== true) {
    logWindowsService(serverDir, `Not adding ${SERVICE_TASK}: this server is not elevated. Rerun setup as an administrator.`);
    return;
  }
  logWindowsService(serverDir, `Adding ${SERVICE_TASK} so this computer keeps serving while its owner is signed out`);
  const result = await runPowerShell(serverDir, "register-machine-service.ps1", [], 120_000);
  logWindowsService(serverDir, result.ok ? `Added ${SERVICE_TASK}` : `Could not add ${SERVICE_TASK}: ${result.output}`);
}

const MACHINE_MARKER = path.join(process.env.ProgramData || "C:\\ProgramData", "SocketAgent", "machine-server.json");

/**
 * C:\ProgramData\SocketAgent\machine-server.json tells the desktop app under
 * every account where this install answers and which key it speaks with.
 * Setup creates the folder so that only SYSTEM and administrators can write
 * it; an elevated or SYSTEM server keeps the record current.
 */
export function refreshMachineMarker(record: { directory: string; port: number; publicKey: string }): void {
  if (!fs.existsSync(path.dirname(MACHINE_MARKER))) return;
  const text = `${JSON.stringify({ ...record, task: SERVICE_TASK }, null, 2)}\n`;
  try {
    if (fs.readFileSync(MACHINE_MARKER, "utf8").replace(/^\uFEFF/, "") === text) return;
  } catch {}
  try {
    const temporary = `${MACHINE_MARKER}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, MACHINE_MARKER);
  } catch (error: unknown) {
    console.warn(`[Service] Could not update ${MACHINE_MARKER}: ${errorMessage(error)}`);
  }
}
