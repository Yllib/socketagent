import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { Backend } from "./protocol";
import { managedNpmBinDir, managedNpmPrefix } from "./socket-agent-paths";

export type BackendInstallPhase = "install" | "auth" | "probe";
export type BackendInstallStatus = "running" | "completed" | "failed";

export interface BackendInstallProgress {
  phase: BackendInstallPhase;
  status: BackendInstallStatus;
  message: string;
  output?: string;
  authUrl?: string;
  authCode?: string;
}

export interface BackendInstallOptions {
  backend: Backend;
  reinstall: boolean;
  authenticate: boolean;
  onProgress: (progress: BackendInstallProgress) => void;
}

const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";

function stripTerminalControl(text: string): string {
  return text
    .replace(
      /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
      ""
    )
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)m/g, "");
}

function commandName(base: string): string {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function existingFile(filePath: string): string | undefined {
  try {
    return fs.existsSync(filePath) ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function resolveManagedCodexCommand(env: NodeJS.ProcessEnv): string | undefined {
  const binDir = managedNpmBinDir(env);
  const names = process.platform === "win32"
    ? ["codex.cmd", "codex.exe", "codex.bat", "codex"]
    : ["codex"];
  for (const name of names) {
    const found = existingFile(path.join(binDir, name));
    if (found) return found;
  }
  return undefined;
}

function installEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const prefix = managedNpmPrefix(env);
  const binDir = managedNpmBinDir(env);
  fs.mkdirSync(binDir, { recursive: true });
  env.NPM_CONFIG_PREFIX = prefix;
  const key = pathKey(env);
  const currentPath = env[key] || env.PATH || "";
  env[key] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
  if (key !== "PATH") env.PATH = env[key];
  return env;
}

function codexAuthFileExists(): boolean {
  const home = process.env.HOME || os.homedir();
  return fs.existsSync(path.join(home, ".codex", "auth.json"));
}

function parseDeviceAuth(text: string): { authUrl?: string; authCode?: string } {
  const url = text.match(/https?:\/\/[^\s)]+/g)?.find((candidate) =>
    candidate.includes("/codex/device") || candidate.includes("device")
  );
  const code = text.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b|\b[A-Z0-9]{8}\b/)?.[0];
  return { authUrl: url, authCode: code };
}

async function runProcess(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  phase: BackendInstallPhase;
  timeoutMs?: number;
  shell?: boolean;
  onProgress: (progress: BackendInstallProgress) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      env: options.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;

    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = stripTerminalControl(chunk.toString("utf8"));
      tail = (tail + text).slice(-12000);
      const auth = options.phase === "auth" ? parseDeviceAuth(text) : {};
      options.onProgress({
        phase: options.phase,
        status: "running",
        message: text.trim() || `${stream} output`,
        output: text,
        ...auth,
      });
    };

    child.stdout.on("data", (chunk) => handleChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => handleChunk("stderr", chunk));

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${options.command} timed out`));
        return;
      }
      if (code === 0) {
        resolve(tail);
        return;
      }
      reject(new Error(`${options.command} exited ${code ?? signal ?? "unknown"}${tail.trim() ? `: ${tail.trim()}` : ""}`));
    });
  });
}

export async function runBackendInstall(options: BackendInstallOptions): Promise<void> {
  if (options.backend !== "codex") {
    throw new Error("In-app backend repair currently supports Codex only");
  }

  const env = installEnv();

  if (options.reinstall) {
    options.onProgress({
      phase: "install",
      status: "running",
      message: `Installing latest OpenAI Codex CLI into ${managedNpmPrefix(env)}...`,
    });
    await runProcess({
      command: commandName("npm"),
      args: [
        "install",
        "-g",
        "--prefix",
        managedNpmPrefix(env),
        "--include=optional",
        "@openai/codex@latest",
      ],
      env,
      phase: "install",
      shell: process.platform === "win32",
      onProgress: options.onProgress,
    });
    const managedCodex = resolveManagedCodexCommand(env);
    if (!managedCodex) {
      throw new Error(`Managed Codex install finished, but no codex executable was created in ${managedNpmBinDir(env)}`);
    }
    options.onProgress({
      phase: "install",
      status: "completed",
      message: `Managed OpenAI Codex CLI install finished: ${managedCodex}`,
    });
  }

  if (options.authenticate) {
    const managedCodex = resolveManagedCodexCommand(env);
    if (!managedCodex) {
      throw new Error(`Managed Codex executable is missing in ${managedNpmBinDir(env)}. Run Install / Repair Codex again.`);
    }
    options.onProgress({
      phase: "auth",
      status: "running",
      message: "Open the OpenAI Codex device page and enter the one-time code.",
      authUrl: CODEX_DEVICE_URL,
    });

    const codex = { command: managedCodex, args: ["login", "--device-auth"], env, shell: process.platform === "win32" && !/\.(?:exe|com)$/i.test(managedCodex) };
    let authDetected = false;
    const authPoll = setInterval(() => {
      if (authDetected || !codexAuthFileExists()) return;
      authDetected = true;
      options.onProgress({
        phase: "auth",
        status: "running",
        message: "Codex authorization detected. Waiting for the login command to finish...",
        authUrl: CODEX_DEVICE_URL,
      });
    }, 2000);
    try {
      await runProcess({
        command: codex.command,
        args: codex.args,
        env: codex.env,
        shell: codex.shell,
        phase: "auth",
        timeoutMs: 15 * 60 * 1000,
        onProgress: options.onProgress,
      });
    } catch (err: any) {
      if (!codexAuthFileExists()) throw err;
      options.onProgress({
        phase: "auth",
        status: "completed",
        message: `Codex login exited with a warning, but auth.json exists: ${err?.message || String(err)}`,
      });
    } finally {
      clearInterval(authPoll);
    }

    if (!codexAuthFileExists()) {
      throw new Error("Codex login finished, but ~/.codex/auth.json was not created");
    }
    options.onProgress({
      phase: "auth",
      status: "completed",
      message: "Codex authentication is available on this server.",
    });
  }

  options.onProgress({
    phase: "probe",
    status: "running",
    message: "Checking Codex CLI...",
  });
  const managedCodex = resolveManagedCodexCommand(env);
  if (!managedCodex) {
    throw new Error(`Managed Codex executable is missing in ${managedNpmBinDir(env)}`);
  }
  const codexVersion = { command: managedCodex, args: ["--version"], env, shell: process.platform === "win32" && !/\.(?:exe|com)$/i.test(managedCodex) };
  await runProcess({
    command: codexVersion.command,
    args: codexVersion.args,
    env: codexVersion.env,
    shell: codexVersion.shell,
    phase: "probe",
    timeoutMs: 10 * 1000,
    onProgress: options.onProgress,
  });
  options.onProgress({
    phase: "probe",
    status: "completed",
    message: "Codex CLI probe completed.",
  });
}
