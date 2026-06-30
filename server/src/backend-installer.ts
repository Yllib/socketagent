import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { Backend } from "./protocol";
import { managedNpmBinDir, managedNpmPrefix } from "./socket-agent-paths";

export type BackendInstallPhase = "install" | "auth" | "probe";
export type BackendInstallStatus = "running" | "completed" | "failed" | "cancelled";

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
  signal?: AbortSignal;
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

function npmGlobalPackageDir(prefix: string, packageName: string): string {
  const parts = packageName.split("/");
  const nodeModules = process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
  return path.join(nodeModules, ...parts);
}

function resolvePackageBin(prefix: string, packageName: string, binName: string): string | undefined {
  const packageDir = npmGlobalPackageDir(prefix, packageName);
  const packageJsonPath = path.join(packageDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
    const binValue = typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin?.[binName] || Object.values(pkg.bin || {})[0];
    if (!binValue) return undefined;
    return existingFile(path.resolve(packageDir, binValue));
  } catch {
    return undefined;
  }
}

function isJavaScriptRuntimeFile(filePath: string): boolean {
  return /\.(?:js|mjs|tsx?|jsx)$/i.test(filePath);
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

function resolveManagedClaudeCommand(env: NodeJS.ProcessEnv): string | undefined {
  const packageBin = resolvePackageBin(managedNpmPrefix(env), "@anthropic-ai/claude-code", "claude");
  if (packageBin) return packageBin;

  const binDir = managedNpmBinDir(env);
  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  for (const name of names) {
    const found = existingFile(path.join(binDir, name));
    if (found) return found;
  }
  return undefined;
}

function resolveManagedBackendCommand(env: NodeJS.ProcessEnv, backend: Backend): string | undefined {
  return backend === "codex"
    ? resolveManagedCodexCommand(env)
    : resolveManagedClaudeCommand(env);
}

function backendDisplayName(backend: Backend): string {
  return backend === "codex" ? "OpenAI Codex CLI" : "Claude Code CLI";
}

function backendPackageName(backend: Backend): string {
  return backend === "codex" ? "@openai/codex@latest" : "@anthropic-ai/claude-code@latest";
}

function buildBackendVersionProbe(backend: Backend, command: string, env: NodeJS.ProcessEnv): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell?: boolean;
} {
  if (backend === "claude" && isJavaScriptRuntimeFile(command)) {
    return { command: process.execPath, args: [command, "--version"], env };
  }
  return {
    command,
    args: ["--version"],
    env,
    shell: process.platform === "win32" && !/\.(?:exe|com)$/i.test(command),
  };
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

function codexAuthFilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".codex", "auth.json");
}

function codexAuthFileExists(): boolean {
  return fs.existsSync(codexAuthFilePath());
}

function codexAuthFileSignature(): string | undefined {
  try {
    const stat = fs.statSync(codexAuthFilePath());
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
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
  signal?: AbortSignal;
  onProgress: (progress: BackendInstallProgress) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Operation cancelled"));
      return;
    }

    const child = spawn(options.command, options.args, {
      env: options.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";
    let timedOut = false;
    let cancelled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      cancelled = true;
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (child.exitCode == null && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 3000);
        forceKill.unref?.();
      }
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();

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
      cleanup();
      reject(cancelled ? new Error("Operation cancelled") : err);
    });

    child.on("close", (code, signal) => {
      cleanup();
      if (cancelled) {
        reject(new Error("Operation cancelled"));
        return;
      }
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

async function runCodexDeviceAuth(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell?: boolean;
  signal?: AbortSignal;
  onProgress: (progress: BackendInstallProgress) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Operation cancelled"));
      return;
    }

    const initialAuthSignature = codexAuthFileSignature();
    const child = spawn(options.command, options.args, {
      env: options.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeout: NodeJS.Timeout;
    let authPoll: NodeJS.Timeout;
    let forceKill: NodeJS.Timeout | undefined;

    const finish = (err?: Error, killChild = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(authPoll);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", handleAbort);
      if (killChild && child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const handleAbort = () => {
      cancelled = true;
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (child.exitCode == null && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 3000);
        forceKill.unref?.();
      }
    };

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    authPoll = setInterval(() => {
      const currentSignature = codexAuthFileSignature();
      if (!currentSignature || currentSignature === initialAuthSignature) return;

      options.onProgress({
        phase: "auth",
        status: "completed",
        message: "Codex authorization detected. Finishing repair...",
        authUrl: CODEX_DEVICE_URL,
      });
      finish(undefined, true);
    }, 1000);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();

    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = stripTerminalControl(chunk.toString("utf8"));
      tail = (tail + text).slice(-12000);
      options.onProgress({
        phase: "auth",
        status: "running",
        message: text.trim() || `${stream} output`,
        output: text,
        ...parseDeviceAuth(text),
      });
    };

    child.stdout.on("data", (chunk) => handleChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => handleChunk("stderr", chunk));

    child.on("error", (err) => finish(cancelled ? new Error("Operation cancelled") : err));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (cancelled) {
        finish(new Error("Operation cancelled"));
        return;
      }
      if (timedOut) {
        finish(new Error(`${options.command} timed out`));
        return;
      }
      if (code === 0 && codexAuthFileExists()) {
        finish();
        return;
      }
      finish(new Error(`${options.command} exited ${code ?? signal ?? "unknown"}${tail.trim() ? `: ${tail.trim()}` : ""}`));
    });
  });
}

export async function runBackendInstall(options: BackendInstallOptions): Promise<void> {
  const env = installEnv();
  const label = backendDisplayName(options.backend);

  if (options.reinstall) {
    options.onProgress({
      phase: "install",
      status: "running",
      message: `Installing latest ${label} into ${managedNpmPrefix(env)}...`,
    });
    await runProcess({
      command: commandName("npm"),
      args: [
        "install",
        "-g",
        "--prefix",
        managedNpmPrefix(env),
        "--include=optional",
        backendPackageName(options.backend),
      ],
      env,
      phase: "install",
      shell: process.platform === "win32",
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const managedCommand = resolveManagedBackendCommand(env, options.backend);
    if (!managedCommand) {
      throw new Error(`Managed ${label} install finished, but no executable was created in ${managedNpmBinDir(env)}`);
    }
    options.onProgress({
      phase: "install",
      status: "completed",
      message: `Managed ${label} install finished: ${managedCommand}`,
    });
  }

  if (options.authenticate) {
    if (options.backend !== "codex") {
      options.onProgress({
        phase: "auth",
        status: "completed",
        message: "Claude repair does not run interactive browser login. If Claude needs sign-in, start a Claude session and use the Claude Login card.",
      });
    } else {
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
      await runCodexDeviceAuth({
        command: codex.command,
        args: codex.args,
        env: codex.env,
        shell: codex.shell,
        timeoutMs: 15 * 60 * 1000,
        signal: options.signal,
        onProgress: options.onProgress,
      });

      if (!codexAuthFileExists()) {
        throw new Error("Codex login finished, but ~/.codex/auth.json was not created");
      }
      options.onProgress({
        phase: "auth",
        status: "completed",
        message: "Codex authentication is available on this server.",
      });
    }
  }

  options.onProgress({
    phase: "probe",
    status: "running",
    message: `Checking ${label}...`,
  });
  const managedCommand = resolveManagedBackendCommand(env, options.backend);
  if (!managedCommand) {
    throw new Error(`Managed ${label} executable is missing in ${managedNpmBinDir(env)}`);
  }
  const versionProbe = buildBackendVersionProbe(options.backend, managedCommand, env);
  await runProcess({
    command: versionProbe.command,
    args: versionProbe.args,
    env: versionProbe.env,
    shell: versionProbe.shell,
    phase: "probe",
    timeoutMs: 10 * 1000,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  options.onProgress({
    phase: "probe",
    status: "completed",
    message: `${label} probe completed.`,
  });
}
