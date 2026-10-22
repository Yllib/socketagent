import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { socketAgentDataDir } from "./socket-agent-paths";
import { errorMessage } from "./value-guards";

// The Windows service config pins the account profile an install belongs to.
// It lives next to server/.env as windows-service.json. A server that runs
// under another account, such as SYSTEM from a machine-wide task, reads it to
// use the owner's data, logins and launcher instead of its own profile, and
// every wrapper or task action the server writes takes its paths from here.

const win = path.win32;

export const WINDOWS_SERVICE_CONFIG_FILE = "windows-service.json";

const absoluteWindowsPath = z.string().min(1).refine((value) => win.isAbsolute(value), "must be an absolute path");

const WindowsServiceConfigSchema = z.object({
  version: z.literal(1),
  /** Account that wrote the config, for diagnostics. */
  owner: z.string(),
  /** USERPROFILE of the owner. HOME uses the same folder. */
  profile: absoluteWindowsPath,
  appData: absoluteWindowsPath,
  localAppData: absoluteWindowsPath,
  /** Codex resolves its home from the account, not USERPROFILE, so it is pinned separately. */
  codexHome: absoluteWindowsPath,
  /** Only recorded when the owner set one; setting it moves where Claude keeps .claude.json. */
  claudeConfigDir: absoluteWindowsPath.optional(),
});

export type WindowsServiceConfig = z.infer<typeof WindowsServiceConfigSchema>;

export type WindowsServiceConfigRead =
  | { status: "ok"; config: WindowsServiceConfig }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

/** The account this process really runs as. Unlike os.homedir(), the profile ignores USERPROFILE. */
export interface ProcessIdentity {
  user: string;
  profile: string;
}

export interface WindowsServiceState {
  identity: ProcessIdentity;
  config?: WindowsServiceConfig;
  configProblem?: string;
  /**
   * True when this process runs as an account other than the install's owner,
   * or as a system account with no config. Such a process uses pinned paths
   * and must never capture its own profile into a wrapper, task or config.
   */
  service: boolean;
}

export function windowsServiceConfigPath(serverDir: string): string {
  return path.join(serverDir, WINDOWS_SERVICE_CONFIG_FILE);
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || "C:\\Windows";
}

function normalizedWindowsPath(value: string): string {
  return win.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

export function sameWindowsPath(left: string, right: string): boolean {
  return normalizedWindowsPath(left) === normalizedWindowsPath(right);
}

/** Profiles of SYSTEM and service accounts live under the Windows folder. */
export function isSystemProfilePath(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = normalizedWindowsPath(systemRoot(env));
  const candidate = normalizedWindowsPath(value);
  return candidate === root || candidate.startsWith(`${root}\\`);
}

function configPaths(config: WindowsServiceConfig): string[] {
  return [config.profile, config.appData, config.localAppData, config.codexHome, config.claudeConfigDir]
    .filter((value): value is string => typeof value === "string");
}

export function parseWindowsServiceConfig(text: string, env: NodeJS.ProcessEnv = process.env): WindowsServiceConfigRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    return { status: "invalid", reason: `not JSON: ${errorMessage(error)}` };
  }
  const parsed = WindowsServiceConfigSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  const systemPath = configPaths(parsed.data).find((value) => isSystemProfilePath(value, env));
  if (systemPath) return { status: "invalid", reason: `points into a system profile: ${systemPath}` };
  return { status: "ok", config: parsed.data };
}

export function readWindowsServiceConfig(serverDir: string, env: NodeJS.ProcessEnv = process.env): WindowsServiceConfigRead {
  let text: string;
  try {
    text = fs.readFileSync(windowsServiceConfigPath(serverDir), "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "missing" };
    return { status: "invalid", reason: errorMessage(error) };
  }
  return parseWindowsServiceConfig(text, env);
}

/**
 * The config for the account running now, from the environment its install
 * already uses. Undefined when that account is a system account.
 */
export function captureWindowsServiceConfig(env: NodeJS.ProcessEnv, identity: ProcessIdentity): WindowsServiceConfig | undefined {
  const profile = env.USERPROFILE || identity.profile;
  const config: WindowsServiceConfig = {
    version: 1,
    owner: identity.user,
    profile,
    appData: env.APPDATA || win.join(profile, "AppData", "Roaming"),
    localAppData: env.LOCALAPPDATA || win.join(profile, "AppData", "Local"),
    codexHome: env.CODEX_HOME?.trim() || win.join(profile, ".codex"),
    ...(env.CLAUDE_CONFIG_DIR?.trim() ? { claudeConfigDir: env.CLAUDE_CONFIG_DIR.trim() } : {}),
  };
  if (isSystemProfilePath(identity.profile, env) || configPaths(config).some((value) => isSystemProfilePath(value, env))) return undefined;
  return config;
}

export function writeWindowsServiceConfig(serverDir: string, config: WindowsServiceConfig): void {
  const target = windowsServiceConfigPath(serverDir);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

export function currentProcessIdentity(env: NodeJS.ProcessEnv = process.env): ProcessIdentity {
  try {
    const info = os.userInfo();
    return { user: info.username, profile: info.homedir };
  } catch {
    return { user: env.USERNAME || "unknown", profile: env.USERPROFILE || os.homedir() };
  }
}

export function windowsServiceState(serverDir: string, env: NodeJS.ProcessEnv, identity: ProcessIdentity): WindowsServiceState {
  const read = readWindowsServiceConfig(serverDir, env);
  if (read.status === "ok") {
    return { identity, config: read.config, service: !sameWindowsPath(identity.profile, read.config.profile) };
  }
  return {
    identity,
    ...(read.status === "invalid" ? { configProblem: read.reason } : {}),
    service: isSystemProfilePath(identity.profile, env),
  };
}

/** Git compares safe.directory against a forward-slash path. */
function gitPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Environment changes that point a service-identity process at the owner's
 * profile. Values the environment already sets for Codex, Claude and git
 * config stay as they are.
 */
export function pinnedServiceEnvironment(config: WindowsServiceConfig, repoRoot: string, env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    HOME: config.profile,
    USERPROFILE: config.profile,
    APPDATA: config.appData,
    LOCALAPPDATA: config.localAppData,
    ...(env.CODEX_HOME?.trim() ? {} : { CODEX_HOME: config.codexHome }),
    ...(config.claudeConfigDir && !env.CLAUDE_CONFIG_DIR?.trim() ? { CLAUDE_CONFIG_DIR: config.claudeConfigDir } : {}),
    // The checkout belongs to the owner, so git refuses it as "dubious
    // ownership" under another account unless it is marked safe.
    ...(env.GIT_CONFIG_COUNT ? {} : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: gitPath(repoRoot) }),
  };
}

/** The launcher the task runs, compiled into the owner's local app data. */
export function windowsLauncherPath(serverDir: string, config: WindowsServiceConfig): string {
  const hash = createHash("sha256").update(fs.readFileSync(path.join(serverDir, "scripts", "windows-launcher.cs"))).digest("hex").slice(0, 16);
  return win.join(config.localAppData, "SocketAgent", "launchers", `socketagent-launcher-${hash}.exe`);
}

function batchSetValue(value: string | undefined): string {
  return String(value || "").replace(/"/g, "");
}

export interface WindowsWrapperInputs {
  serverDir: string;
  repoRoot: string;
  config: WindowsServiceConfig;
  /** PATH the server should run with. */
  path: string;
  powershellExe: string;
  nodeExe: string;
  launcher: string;
}

export function windowsRecoveryBatContent(serverDir: string, powershellExe: string): string {
  const logFile = win.join(serverDir, "socketagent.log");
  return [
    "@echo off",
    "setlocal EnableExtensions",
    "rem SocketAgent Windows recovery guard",
    `set "SERVER_DIR=${batchSetValue(serverDir)}"`,
    `set "LOG_FILE=${batchSetValue(logFile)}"`,
    `set "POWERSHELL_EXE=${batchSetValue(powershellExe)}"`,
    'set "PORT=8085"',
    'for /f "tokens=1,* delims==" %%A in (\'findstr /b "PORT=" "%SERVER_DIR%\\.env" 2^>nul\') do if /i "%%A"=="PORT" set "PORT=%%B"',
    'set "PORT=%PORT:"=%"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=[int]$env:PORT; $c=New-Object Net.Sockets.TcpClient; try { $iar=$c.BeginConnect(\'127.0.0.1\',$p,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne(1500,$false)) { exit 1 }; $c.EndConnect($iar); exit 0 } catch { exit 1 } finally { $c.Close() }"',
    "if not errorlevel 1 goto done",
    'echo [recovery] SocketAgent is not listening on port %PORT%; restarting scheduled task. >> "%LOG_FILE%" 2>&1',
    'set "TASK_NAME=SocketAgent"',
    'schtasks /Query /TN SocketAgent >nul 2>&1 || set "TASK_NAME=SocketClaude"',
    'schtasks /End /TN "%TASK_NAME%" >> "%LOG_FILE%" 2>&1',
    '"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2" >nul 2>&1',
    'schtasks /Run /TN "%TASK_NAME%" >> "%LOG_FILE%" 2>&1',
    ":done",
    "schtasks /Delete /TN SocketAgentRecovery /F >nul 2>&1",
    "exit /b 0",
    "",
  ].join("\r\n");
}

/** run-service.bat: the restart loop the SocketAgent task runs. */
export function windowsRunServiceBatContent(inputs: WindowsWrapperInputs): string {
  const { config, serverDir } = inputs;
  const logFile = win.join(serverDir, "socketagent.log");
  const serverScript = win.join(serverDir, "dist", "index.js");

  return [
    "@echo off",
    "setlocal EnableExtensions",
    "rem SocketAgent Windows service wrapper v2",
    `set "HOME=${batchSetValue(config.profile)}"`,
    `set "PATH=${batchSetValue(inputs.path)}"`,
    `set "SERVER_DIR=${batchSetValue(serverDir)}"`,
    `set "REPO_ROOT=${batchSetValue(inputs.repoRoot)}"`,
    `set "LOG_FILE=${batchSetValue(logFile)}"`,
    `set "POWERSHELL_EXE=${batchSetValue(inputs.powershellExe)}"`,
    `set "NODE_EXE=${batchSetValue(inputs.nodeExe)}"`,
    `set "SERVER_SCRIPT=${batchSetValue(serverScript)}"`,
    `set "RECOVERY_BAT=${batchSetValue(win.join(serverDir, "run-recovery.bat"))}"`,
    `set "SOCKETAGENT_LAUNCHER=${batchSetValue(inputs.launcher)}"`,
    'set "NPM_CMD=npm.cmd"',
    'set "NPX_CMD=npx.cmd"',
    'if exist "%ProgramFiles%\\nodejs\\npm.cmd" set "NPM_CMD=%ProgramFiles%\\nodejs\\npm.cmd"',
    'if exist "%ProgramFiles%\\nodejs\\npx.cmd" set "NPX_CMD=%ProgramFiles%\\nodejs\\npx.cmd"',
    "",
    'if "%SOCKETAGENT_SUPERVISED%"=="1" goto loop',
    '"%SOCKETAGENT_LAUNCHER%" --hide-parent-console "%~f0"',
    "exit /b %ERRORLEVEL%",
    "",
    ":loop",
    "call :arm_recovery",
    'call :preflight >> "%LOG_FILE%" 2>&1',
    'if errorlevel 1 echo [startup] Preflight update failed; launching existing build. >> "%LOG_FILE%" 2>&1',
    'cd /d "%SERVER_DIR%"',
    '"%NODE_EXE%" "%SERVER_SCRIPT%" >> "%LOG_FILE%" 2>&1',
    'echo Server exited (%ERRORLEVEL%), restarting in 5s... >> "%LOG_FILE%" 2>&1',
    '"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 5" >nul 2>&1',
    "goto loop",
    "",
    // Everything above must stay byte-identical for a given install: cmd
    // resumes a running batch file by offset after the server rewrites it.
    // Each pass of the loop calls :arm_recovery first, so new startup steps
    // hang off it.
    ":arm_recovery",
    "call :pin_profile",
    "call :single_server",
    'if not exist "%RECOVERY_BAT%" exit /b 0',
    '"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%SERVER_DIR%\\scripts\\register-windows-recovery.ps1" >nul 2>&1',
    "exit /b 0",
    "",
    // Under any account but the owner's, use the owner's profile, Codex home
    // and checkout, as the server does for itself in windows-service-env.
    ":pin_profile",
    `if /I "%USERPROFILE%"=="${batchSetValue(config.profile)}" exit /b 0`,
    `set "USERPROFILE=${batchSetValue(config.profile)}"`,
    `set "APPDATA=${batchSetValue(config.appData)}"`,
    `set "LOCALAPPDATA=${batchSetValue(config.localAppData)}"`,
    `if not defined CODEX_HOME set "CODEX_HOME=${batchSetValue(config.codexHome)}"`,
    'if not exist "%CODEX_HOME%\\" mkdir "%CODEX_HOME%" >nul 2>&1',
    ...(config.claudeConfigDir ? [`if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=${batchSetValue(config.claudeConfigDir)}"`] : []),
    "if defined GIT_CONFIG_COUNT exit /b 0",
    'set "GIT_CONFIG_COUNT=1"',
    'set "GIT_CONFIG_KEY_0=safe.directory"',
    `set "GIT_CONFIG_VALUE_0=${batchSetValue(gitPath(inputs.repoRoot))}"`,
    "exit /b 0",
    "",
    // A copy started by a logon task stops here when the machine service
    // already serves. `exit` without /b ends this whole cmd.exe. It writes
    // no log line: the serving wrapper's redirect holds the log against
    // other writers.
    ":single_server",
    '"%NODE_EXE%" "%SERVER_DIR%\\scripts\\check-machine-service.js" >nul 2>&1',
    "if errorlevel 1 exit /b 0",
    "exit 0",
    "",
    ":preflight",
    "call :update",
    'set "UPDATE_RESULT=%ERRORLEVEL%"',
    '"%NODE_EXE%" "%SERVER_DIR%\\scripts\\build-server.js"',
    "if errorlevel 1 exit /b 1",
    "exit /b %UPDATE_RESULT%",
    "",
    ":update",
    'cd /d "%REPO_ROOT%"',
    'if /I "%SOCKETAGENT_AUTO_UPDATE%"=="0" exit /b 0',
    'if /I "%SOCKETAGENT_AUTO_UPDATE%"=="false" exit /b 0',
    'if /I "%SOCKETAGENT_AUTO_UPDATE%"=="off" exit /b 0',
    "git rev-parse --is-inside-work-tree >nul 2>&1 || exit /b 0",
    "git fetch origin",
    "if errorlevel 1 exit /b 0",
    "set \"BRANCH=\"",
    "set \"LOCAL_HASH=\"",
    "set \"REMOTE_HASH=\"",
    "for /f %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set \"BRANCH=%%B\"",
    "if not defined BRANCH exit /b 0",
    "for /f %%H in ('git rev-parse HEAD 2^>nul') do set \"LOCAL_HASH=%%H\"",
    "for /f %%H in ('git rev-parse origin/%BRANCH% 2^>nul') do set \"REMOTE_HASH=%%H\"",
    "if not defined REMOTE_HASH exit /b 0",
    'if "%LOCAL_HASH%"=="%REMOTE_HASH%" exit /b 0',
    'call :verify_update "%REMOTE_HASH%"',
    "if errorlevel 1 exit /b 1",
    "echo [Auto-update] Applying %REMOTE_HASH:~0,7% from origin/%BRANCH%",
    "git reset --hard origin/%BRANCH%",
    "if errorlevel 1 exit /b 1",
    'cd /d "%SERVER_DIR%"',
    'call "%NPM_CMD%" ci --include=optional',
    "if errorlevel 1 exit /b 1",
    '> "%REPO_ROOT%\\.last-auto-update-hash" echo %REMOTE_HASH%',
    "exit /b 0",
    "",
    ":verify_update",
    'set "VERIFY_MODE=%SOCKETAGENT_AUTO_UPDATE_VERIFY%"',
    'set "REQUIRE_SIGNED=%SOCKETAGENT_AUTO_UPDATE_REQUIRE_SIGNED_COMMITS%"',
    'if not defined VERIFY_MODE set "VERIFY_MODE=commit"',
    'if /I "%VERIFY_MODE%"=="none" exit /b 0',
    'if /I "%VERIFY_MODE%"=="0" exit /b 0',
    'if /I "%VERIFY_MODE%"=="false" exit /b 0',
    'if /I "%VERIFY_MODE%"=="off" exit /b 0',
    'if /I "%SOCKETAGENT_UPDATE_VERIFY%"=="commit" set "VERIFY_MODE=commit"',
    'if /I "%SOCKETAGENT_UPDATE_VERIFY%"=="signed-commit" set "VERIFY_MODE=commit"',
    'if /I "%SOCKETAGENT_UPDATE_REQUIRE_SIGNED_COMMITS%"=="1" set "REQUIRE_SIGNED=1"',
    'if /I "%REQUIRE_SIGNED%"=="0" exit /b 0',
    'if /I "%REQUIRE_SIGNED%"=="false" exit /b 0',
    'if /I "%REQUIRE_SIGNED%"=="off" exit /b 0',
    'if /I "%VERIFY_MODE%"=="signed" set "VERIFY_MODE=commit"',
    'if /I "%VERIFY_MODE%"=="signed-commit" set "VERIFY_MODE=commit"',
    'if /I "%REQUIRE_SIGNED%"=="true" set "VERIFY_MODE=commit"',
    'if /I "%REQUIRE_SIGNED%"=="yes" set "VERIFY_MODE=commit"',
    'if "%REQUIRE_SIGNED%"=="1" set "VERIFY_MODE=commit"',
    'if /I not "%VERIFY_MODE%"=="commit" exit /b 0',
    'set "SIGNERS=%REPO_ROOT%\\.github\\allowed_signers"',
    'if not exist "%SIGNERS%" exit /b 1',
    'git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=%SIGNERS%" verify-commit "%~1"',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

/** Who and where this process runs, for health and the probe. */
export function describeRuntime(state: WindowsServiceState, serverDir: string, env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || os.homedir();
  const profile = env.USERPROFILE || home;
  return {
    user: state.identity.user,
    accountProfile: state.identity.profile,
    service: state.service,
    config: state.config ? windowsServiceConfigPath(serverDir) : null,
    ...(state.configProblem ? { configProblem: state.configProblem } : {}),
    home,
    profile,
    // Codex ignores USERPROFILE on Windows and uses the account's profile.
    codexHome: env.CODEX_HOME?.trim() || path.join(process.platform === "win32" ? state.identity.profile : home, ".codex"),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR?.trim() || path.join(profile, ".claude"),
    dataDir: socketAgentDataDir(env),
  };
}
