import { spawnSync } from "child_process";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { isJavaScriptRuntimeFile, resolveClaudeExecutable } from "./claude-executable";
import { buildCodexSpawn } from "./codex-env";
import { socketAgentDataDir } from "./socket-agent-paths";
import { errorMessage, isRecord } from "./value-guards";
import {
  captureWindowsServiceConfig,
  currentProcessIdentity,
  describeRuntime,
  pinnedServiceEnvironment,
  readWindowsServiceConfig,
  windowsLauncherPath,
  windowsRecoveryBatContent,
  windowsRunServiceBatContent,
  windowsServiceConfigPath,
  windowsServiceState,
  writeWindowsServiceConfig,
  type WindowsServiceConfig,
  type WindowsServiceState,
} from "./windows-service-config";
import { arbitrate } from "./windows-machine-service";

// Windows service commands that run without the server.
//
//   node dist/windows-service-cli.js wrapper [--keep-config]
//     Used by install.ps1. Records windows-service.json for the account running
//     setup and writes run-service.bat and run-recovery.bat from it. PATH,
//     POWERSHELL_EXE and SOCKETAGENT_NODE come from the environment. With
//     --keep-config it uses the recorded config instead, as
//     move-windows-install.ps1 does under any account.
//
//   node dist/windows-service-cli.js probe --port N [--timeout S]
//     Checks that this account, with the install's pinned paths, can run the
//     server: node, the build, .env, data, git, Codex, Claude and their logins.
//     Answers GET /health on 127.0.0.1:N with the report once, prints it, and
//     exits 0 when nothing failed. It starts no relay and writes no files.
//
//   node dist/windows-service-cli.js arbitrate
//     run-service.bat runs this before each server start and serves once it
//     returns. Under SYSTEM it waits while the owner's copy runs; under the
//     owner it moves a serving SYSTEM server out of the way. See
//     windows-machine-service.ts.

const SERVER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const NODE_MIN_MAJOR = 22;
const COMMAND_TIMEOUT_MS = 90_000;

type CheckStatus = "ok" | "missing" | "fail";

interface ProbeCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

function fail(message: string): never {
  console.error(`[windows-service] ${message}`);
  process.exit(1);
}

function writeIfChanged(file: string, content: string): void {
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch {}
  if (current.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n")) return;
  fs.writeFileSync(file, content, "ascii");
  console.log(`Wrote ${file}`);
}

function wrapperConfig(keep: boolean): WindowsServiceConfig {
  if (keep) {
    const read = readWindowsServiceConfig(SERVER_DIR);
    if (read.status !== "ok") fail(`No usable ${windowsServiceConfigPath(SERVER_DIR)}: ${read.status === "invalid" ? read.reason : "missing"}`);
    return read.config;
  }
  const config = captureWindowsServiceConfig(process.env, currentProcessIdentity());
  if (!config) fail("Refusing to record a system profile as the install's owner. Run setup as the account that owns this install.");
  writeWindowsServiceConfig(SERVER_DIR, config);
  console.log(`Wrote ${windowsServiceConfigPath(SERVER_DIR)}`);
  return config;
}

function writeWrapper(args: string[]): void {
  const config = wrapperConfig(args.includes("--keep-config"));
  const powershellExe = process.env.POWERSHELL_EXE || "powershell.exe";
  writeIfChanged(path.join(SERVER_DIR, "run-service.bat"), windowsRunServiceBatContent({
    serverDir: SERVER_DIR,
    repoRoot: REPO_ROOT,
    config,
    path: process.env.PATH || "",
    powershellExe,
    nodeExe: process.env.SOCKETAGENT_NODE || process.execPath,
    launcher: windowsLauncherPath(SERVER_DIR, config),
  }));
  writeIfChanged(path.join(SERVER_DIR, "run-recovery.bat"), windowsRecoveryBatContent(SERVER_DIR, powershellExe));
}

function fileCheck(name: string, file: string): ProbeCheck {
  return fs.existsSync(file)
    ? { name, status: "ok", detail: file }
    : { name, status: "missing", detail: file };
}

/** Runs a short command and reports its first output line. */
function commandCheck(name: string, command: string, args: string[], options: { env?: NodeJS.ProcessEnv; shell?: boolean } = {}): ProbeCheck {
  const result = spawnSync(command, args, {
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) return { name, status: "fail", detail: `${command}: ${errorMessage(result.error)}` };
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0] || "";
  if (result.status !== 0) return { name, status: "fail", detail: `${command} exited ${result.status}: ${output}` };
  return { name, status: "ok", detail: output };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Claude keeps its login in Windows Credential Manager, which a different
 * account cannot read, when this flag is on. The probe flags it before a
 * cutover can strand the service without the owner's login.
 */
function claudeCredentialManagerCheck(service: boolean): ProbeCheck {
  const name = "claude-credential-store";
  if (process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === "1") {
    return { name, status: service ? "fail" : "ok", detail: "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1" };
  }
  const file = path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || os.homedir(), ".claude.json");
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (error: unknown) {
    return { name, status: "missing", detail: `${file}: ${errorMessage(error)}` };
  }
  const features = isRecord(raw) ? raw.cachedGrowthBookFeatures : undefined;
  const credman = isRecord(features) && features.tengu_windows_credman === true;
  if (!credman) return { name, status: "ok", detail: "credentials file" };
  return { name, status: service ? "fail" : "ok", detail: "Windows Credential Manager (tengu_windows_credman)" };
}

function probeChecks(state: WindowsServiceState, env: Record<string, string>): ProbeCheck[] {
  const checks: ProbeCheck[] = [];
  const configFile = windowsServiceConfigPath(SERVER_DIR);
  if (state.config) checks.push({ name: "config", status: "ok", detail: configFile });
  else if (state.configProblem) checks.push({ name: "config", status: "fail", detail: state.configProblem });
  else checks.push({ name: "config", status: state.service ? "fail" : "missing", detail: configFile });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", status: nodeMajor >= NODE_MIN_MAJOR ? "ok" : "fail", detail: `${process.execPath} v${process.versions.node}` });

  const buildFailure = path.join(SERVER_DIR, "dist", ".build-failure.json");
  const serverScript = path.join(SERVER_DIR, "dist", "index.js");
  if (!fs.existsSync(serverScript)) checks.push({ name: "build", status: "fail", detail: `${serverScript} is missing` });
  else if (fs.existsSync(buildFailure)) checks.push({ name: "build", status: "fail", detail: `last compile failed, see ${buildFailure}` });
  else checks.push({ name: "build", status: "ok", detail: serverScript });

  checks.push(env.AUTH_TOKEN
    ? { name: "env", status: "ok", detail: "AUTH_TOKEN set" }
    : { name: "env", status: "fail", detail: `${path.join(SERVER_DIR, ".env")} has no AUTH_TOKEN` });

  const dataDir = socketAgentDataDir(process.env);
  const keysFile = path.join(dataDir, "relay-keys.json");
  if (!fs.existsSync(dataDir)) checks.push({ name: "data", status: "missing", detail: dataDir });
  else if (!fs.existsSync(keysFile)) checks.push({ name: "data", status: "missing", detail: keysFile });
  else {
    try {
      readJson(keysFile);
      checks.push({ name: "data", status: "ok", detail: keysFile });
    } catch (error: unknown) {
      checks.push({ name: "data", status: "fail", detail: `${keysFile}: ${errorMessage(error)}` });
    }
  }

  checks.push(commandCheck("git", "git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]));

  const codex = buildCodexSpawn(["--version"]);
  checks.push(commandCheck("codex", codex.command, codex.args, { env: codex.env, shell: codex.shell }));
  checks.push(fileCheck("codex-login", path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "auth.json")));

  const claude = resolveClaudeExecutable();
  if (!claude.path) checks.push({ name: "claude", status: "fail", detail: claude.reason || "Claude Code not found" });
  else if (isJavaScriptRuntimeFile(claude.path)) checks.push(commandCheck("claude", process.execPath, [claude.path, "--version"]));
  else checks.push(commandCheck("claude", claude.path, ["--version"]));
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  checks.push(process.env.ANTHROPIC_API_KEY
    ? { name: "claude-login", status: "ok", detail: "ANTHROPIC_API_KEY" }
    : fileCheck("claude-login", path.join(claudeDir, ".credentials.json")));
  checks.push(claudeCredentialManagerCheck(state.service));
  return checks;
}

function numberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) fail(`${flag} needs a positive whole number`);
  return value;
}

function probe(args: string[]): void {
  const port = numberFlag(args, "--port") ?? fail("probe needs --port N");
  const timeoutSeconds = numberFlag(args, "--timeout") ?? 120;
  const state = windowsServiceState(SERVER_DIR, process.env, currentProcessIdentity());
  // The same pins the server applies in windows-service-env, minus creating
  // CODEX_HOME, so every check below sees what the real server would.
  if (state.service && state.config) Object.assign(process.env, pinnedServiceEnvironment(state.config, process.env));
  let env: Record<string, string> = {};
  try { env = dotenv.parse(fs.readFileSync(path.join(SERVER_DIR, ".env"))); } catch {}
  for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;

  const checks = probeChecks(state, env);
  const report = {
    service: "socketagent-probe",
    ok: checks.every((check) => check.status !== "fail"),
    identity: describeRuntime(state, SERVER_DIR),
    checks,
  };
  const body = JSON.stringify(report, null, 2);
  const finish = (code: number) => {
    console.log(body);
    process.exit(code);
  };

  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    if (env.AUTH_TOKEN && request.headers.authorization !== `Bearer ${env.AUTH_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(body, () => finish(report.ok ? 0 : 1));
  });
  server.on("error", (error) => fail(`Could not listen on 127.0.0.1:${port}: ${errorMessage(error)}`));
  server.listen(port, "127.0.0.1", () => console.error(`[windows-service] Probe answering on http://127.0.0.1:${port}/health`));
  setTimeout(() => {
    console.error(`[windows-service] No health request within ${timeoutSeconds}s`);
    finish(2);
  }, timeoutSeconds * 1000).unref();
}

const [command, ...rest] = process.argv.slice(2);
if (command === "wrapper") writeWrapper(rest);
else if (command === "probe") probe(rest);
else if (command === "arbitrate") void arbitrate(SERVER_DIR, windowsServiceState(SERVER_DIR, process.env, currentProcessIdentity()).service);
else fail("usage: windows-service-cli.js wrapper [--keep-config] | probe --port N [--timeout S] | arbitrate");
