import { parseJsonObject, errorMessage, errorCode } from "./value-guards";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Backend, BackendHealthInfo, CodexDriver, ComputerIssue } from "./protocol";
import { buildCodexSpawn, resolveCodexCommand } from "./codex-env";
import { getCodexLinuxSandboxHealth } from "./codex-linux-sandbox";
import { resolveClientPath } from "./path-utils";
import { backendConfigFileIdForPath } from "./backend-config-files";
import { buildClaudeExecutableSpawn, getClaudeExecutableInfo, type ClaudeAvailability } from "./claude-session";
import { BackgroundProbe, runProbe, type ProbeResult } from "./async-probe";
import { readClaudeAuthState, readCodexAuthState } from "./backend-auth";
import {
  legacyManagedNpmBinDir,
  managedNpmBinDir,
  managedNpmPrefix,
  socketAgentDataPath,
} from "./socket-agent-paths";

export interface ServerSettings {
  codexDriver: CodexDriver;
  defaultCwd: string;
  systemPrompt: string;
  systemPromptInitialized: boolean;
  /** Null explicitly delegates the window selection to the Claude SDK/model. */
  claudeAutoCompactWindow: number | null;
  /**
   * Internal migration marker. Older settings serialized null as the implicit
   * default; true means the user deliberately selected the stored value.
   */
  claudeAutoCompactWindowConfigured?: boolean;
  /** Days to keep SendFile snapshots; 0 keeps them forever. */
  sentFileRetentionDays: number;
}

const STORE_DIR = socketAgentDataPath();
const SETTINGS_FILE = path.join(STORE_DIR, "server-settings.json");
const DEFAULT_CODEX_DRIVER: CodexDriver = "app-server";
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 250_000;
export const DEFAULT_SENT_FILE_RETENTION_DAYS = 30;
const BOOT_DEFAULT_CWD = resolveClientPath(process.env.DEFAULT_CWD || process.cwd()).resolvedPath || path.resolve(process.cwd());
const BACKEND_HEALTH_CACHE_MS = 10000;
// Probes run off the event loop, so they can wait out a slow first start,
// such as antivirus scanning a freshly installed codex.exe.
const BACKEND_PROBE_TIMEOUT_MS = 30_000;

let cachedSettings: ServerSettings | null = null;
let cachedBackendHealth: { checkedAt: number; value: BackendHealthInfo[] } | null = null;

const LEGACY_AUTOMATIC_HTML_PLAN_RULES = [
  "- For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the html plan tool, and stop. Wait for a pick before implementing. Non-trivial is a key word here. If exact direction is given this isnt necessary.",
  "- Do not edit real components first. For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the html plan tool, and stop. Wait for a pick before implementing. Non-trivial is a key word here.",
];
const EXPLICIT_HTML_PLAN_RULE =
  "- Use the HTML plan tool only when the user explicitly asks for an HTML plan or explicitly asks to use that tool. Never invoke it automatically for UI, layout, copy, mockups, or implementation planning. When the user gives exact UI direction, implement it directly.";

export function normalizeSystemPrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  let prompt = value;
  for (const legacyRule of LEGACY_AUTOMATIC_HTML_PLAN_RULES) {
    prompt = prompt.replace(legacyRule, EXPLICIT_HTML_PLAN_RULE);
  }
  return prompt.slice(0, 20_000);
}

export function normalizeClaudeAutoCompactWindow(value: unknown): number | null {
  // An absent persisted setting receives SocketAgent's bounded default. Null
  // remains a deliberate escape hatch for users who want the SDK/model default.
  if (value === undefined) return DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100_000 || parsed > 1_000_000) {
    throw new Error("Claude auto-compact window must be an integer from 100,000 to 1,000,000 tokens");
  }
  return parsed;
}

export function normalizeSentFileRetentionDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_SENT_FILE_RETENTION_DAYS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 3650) {
    throw new Error("Sent file retention must be a whole number of days from 0 to 3650");
  }
  return parsed;
}

export function resolvePersistedClaudeAutoCompactWindow(
  value: unknown,
  explicitlyConfigured: unknown,
): number | null {
  if (explicitlyConfigured === true) {
    return normalizeClaudeAutoCompactWindow(value);
  }
  // Preserve legacy numeric choices, but migrate the old implicit null/absent
  // default to SocketAgent's bounded default.
  if (value !== undefined && value !== null && value !== "") {
    return normalizeClaudeAutoCompactWindow(value);
  }
  return DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW;
}
const backendHealthOverrides = new Map<Backend, BackendHealthInfo>();

/** Re-derives backend health and makes the next availability check probe the CLIs again. */
export function invalidateBackendHealthCache(): void {
  cachedBackendHealth = null;
  codexCliProbe.invalidate();
  claudeCliProbe.invalidate();
}

export function markBackendAuthRequired(backend: Backend, detail?: string): void {
  const label = backend === "codex" ? "Codex" : "Claude";
  backendHealthOverrides.set(backend, {
    backend,
    enabled: true,
    available: false,
    severity: "error",
    kind: "auth",
    reason: `${label} authentication is invalid or expired. Sign in again.`,
    detail,
  });
  invalidateBackendHealthCache();
}

export function clearBackendHealthOverride(backend: Backend): void {
  if (backendHealthOverrides.delete(backend)) {
    invalidateBackendHealthCache();
  }
}

/** Config problems Codex reported, with the config file's modified time when seen. */
const codexConfigWarnings = new Map<string, { file: string; mtimeMs: number }>();
const backendHealthListeners = new Set<() => void>();

function modifiedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function notifyBackendHealthChange(): void {
  cachedBackendHealth = null;
  for (const listener of backendHealthListeners) listener();
}

/** Calls [listener] when backend health changes. Returns an unsubscribe. */
export function onBackendHealthChange(listener: () => void): () => void {
  backendHealthListeners.add(listener);
  return () => backendHealthListeners.delete(listener);
}

/**
 * Records a config problem Codex reported as it started. It shows in the
 * computer's errors and warnings, not in chat, until the config file changes.
 * Codex reports it again on its next start if the change did not fix it.
 */
export function recordCodexConfigWarning(message: string, configPath?: string): void {
  if (codexConfigWarnings.has(message)) return;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const file = configPath || path.join(codexHome, "config.toml");
  codexConfigWarnings.set(message, { file, mtimeMs: modifiedAt(file) });
  notifyBackendHealthChange();
}

let windowsServiceWarning: string | undefined;

/**
 * Shows, or with undefined clears, why this Windows install serves only
 * while its owner is signed in. See addMachineServiceTask.
 */
export function setWindowsServiceWarning(message: string | undefined): void {
  if (message === windowsServiceWarning) return;
  windowsServiceWarning = message;
  notifyBackendHealthChange();
}

let installRepairWarning: string | undefined;

/**
 * Shows, or with undefined clears, what the repair of an interrupted Windows
 * install move could not do by itself. See windows-install-repair.
 */
export function setInstallRepairWarning(message: string | undefined): void {
  if (message === installRepairWarning) return;
  installRepairWarning = message;
  notifyBackendHealthChange();
}

/**
 * The computer's problems: a Windows install without SocketAgentService, one
 * left half-moved, and recorded Codex config problems whose file has not
 * changed since.
 */
export function getComputerIssues(): ComputerIssue[] {
  const issues: ComputerIssue[] = [windowsServiceWarning, installRepairWarning]
    .filter((message): message is string => message !== undefined)
    .map((message) => ({ severity: "warning", message }));
  for (const [message, seen] of codexConfigWarnings) {
    if (modifiedAt(seen.file) !== seen.mtimeMs) codexConfigWarnings.delete(message);
    else {
      const configFile = backendConfigFileIdForPath(seen.file);
      issues.push({
        backend: "codex",
        severity: "warning",
        message,
        path: seen.file,
        ...(configFile ? { configFile } : {}),
      });
    }
  }
  return issues;
}

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function normalizeDriver(_value: unknown): CodexDriver {
  return "app-server";
}

function normalizeDefaultCwd(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return BOOT_DEFAULT_CWD;
  return resolveClientPath(value).resolvedPath || BOOT_DEFAULT_CWD;
}

function pathStartsWith(candidate: string | undefined, dir: string): boolean {
  if (!candidate) return false;
  try {
    const resolvedCandidate = path.resolve(candidate).toLowerCase();
    const resolvedDir = path.resolve(dir).toLowerCase();
    return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(resolvedDir + path.sep);
  } catch {
    return false;
  }
}

function codexCommandSource(command: string): BackendHealthInfo["source"] {
  if (pathStartsWith(command, managedNpmBinDir())) return "managed";
  if (pathStartsWith(command, legacyManagedNpmBinDir())) return "legacy";
  if (command === "codex" || command === "codex.cmd") return "path";
  return "system";
}

function managedSourceWarning(backend: Backend, source: BackendHealthInfo["source"]): string | undefined {
  if (source === "managed" || source === "explicit") return undefined;
  if (source === "sdk") {
    return `${backend === "codex" ? "Codex" : "Claude"} is using the SDK-bundled executable instead of the SocketAgent-managed toolchain. Repair the backend to install and use the managed copy.`;
  }
  if (source === "legacy") {
    return `${backend === "codex" ? "Codex" : "Claude"} is using the old SocketAgent toolchain location. Repair the backend to move it under .socket-agent.`;
  }
  if (source === "system" || source === "path") {
    return `${backend === "codex" ? "Codex" : "Claude"} is using the system install instead of the SocketAgent-managed toolchain. Local customizations can break SocketAgent.`;
  }
  return undefined;
}

function firstOutputLine(stdout?: string | Buffer, stderr?: string | Buffer): string | undefined {
  const text = `${stdout || ""}\n${stderr || ""}`.trim();
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

/** Why a probe failed, or undefined when it exited 0. */
function probeFailure(label: string, result: ProbeResult): string | undefined {
  if (result.error) {
    return errorCode(result.error) === "ENOENT"
      ? `${label} was not found.`
      : `${label} probe failed: ${result.error.message}`;
  }
  if (result.timedOut) return `${label} probe timed out after ${BACKEND_PROBE_TIMEOUT_MS / 1000}s`;
  if (result.status !== 0) {
    const detail = firstOutputLine(result.stdout, result.stderr);
    return detail ? `${label} probe exited ${result.status}: ${detail}` : `${label} probe exited ${result.status}`;
  }
  return undefined;
}

interface CodexCliProbe {
  command: string;
  version: ProbeResult;
  /** Run only once `codex --version` succeeds. */
  appServer?: ProbeResult;
}

async function probeCodexCli(): Promise<CodexCliProbe> {
  const codexVersion = buildCodexSpawn(["--version"]);
  const command = resolveCodexCommand(codexVersion.env);
  const version = await runProbe(codexVersion.command, codexVersion.args, {
    env: codexVersion.env, shell: codexVersion.shell, timeoutMs: BACKEND_PROBE_TIMEOUT_MS,
  });
  if (version.status !== 0) return { command, version };
  const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
  const appServer = await runProbe(appServerHelp.command, appServerHelp.args, {
    env: appServerHelp.env, shell: appServerHelp.shell, timeoutMs: BACKEND_PROBE_TIMEOUT_MS,
  });
  return { command, version, appServer };
}

const codexCliProbe = new BackgroundProbe(probeCodexCli, BACKEND_HEALTH_CACHE_MS, notifyBackendHealthChange);

export interface CodexAvailability {
  available: boolean;
  reason?: string;
}

function codexAvailabilityFrom(cli: CodexCliProbe): CodexAvailability {
  const versionFailure = probeFailure("Codex CLI", cli.version);
  if (versionFailure) return { available: false, reason: versionFailure };
  const home = process.env.HOME || os.homedir();
  if (!fs.existsSync(path.join(home, ".codex", "auth.json"))) {
    return { available: false, reason: "Codex CLI is installed but ~/.codex/auth.json is missing" };
  }
  const appServerFailure = cli.appServer && probeFailure("Codex app-server", cli.appServer);
  if (appServerFailure) return { available: false, reason: appServerFailure };
  return { available: true };
}

/** Waits for a current Codex CLI check. Use where an answer is needed before acting. */
export async function probeCodexAvailability(): Promise<CodexAvailability> {
  return codexAvailabilityFrom(await codexCliProbe.fresh());
}

/** The last known Codex availability without waiting; undefined before the first check finishes. */
export function peekCodexAvailability(): CodexAvailability | undefined {
  const cli = codexCliProbe.peek();
  return cli && codexAvailabilityFrom(cli);
}

async function probeClaudeCli(): Promise<ClaudeAvailability> {
  const info = getClaudeExecutableInfo();
  const probe = buildClaudeExecutableSpawn(["--version"], info);
  if (!info.path || !probe) {
    return { available: false, reason: info.reason || "No Claude executable is available." };
  }
  const result = await runProbe(probe.command, probe.args, {
    shell: probe.shell, timeoutMs: BACKEND_PROBE_TIMEOUT_MS,
  });
  const detail = firstOutputLine(result.stdout, result.stderr);
  if (result.error && errorCode(result.error) === "ENOENT") {
    return { available: false, reason: "Claude executable was not found.", detail };
  }
  const failure = probeFailure("Claude executable", result);
  if (failure) return { available: false, reason: failure, detail };
  return { available: true, version: detail };
}

const claudeCliProbe = new BackgroundProbe(probeClaudeCli, BACKEND_HEALTH_CACHE_MS, notifyBackendHealthChange);

/** Waits for a current Claude CLI check. */
export async function getClaudeAvailability(): Promise<ClaudeAvailability> {
  return claudeCliProbe.fresh();
}

/** The last known Claude availability without waiting; undefined before the first check finishes. */
export function peekClaudeAvailability(): ClaudeAvailability | undefined {
  return claudeCliProbe.peek();
}

function codexHealth(cli: CodexCliProbe): BackendHealthInfo {
  const source = codexCommandSource(cli.command);
  const base: BackendHealthInfo = {
    backend: "codex",
    enabled: true,
    available: false,
    severity: "error",
    source,
    command: cli.command,
    installRoot: managedNpmPrefix(),
  };

  const versionFailure = probeFailure("Codex CLI", cli.version);
  if (versionFailure) {
    return { ...base, reason: versionFailure, detail: firstOutputLine(cli.version.stdout, cli.version.stderr) };
  }
  const version = firstOutputLine(cli.version.stdout, cli.version.stderr);

  const auth = readCodexAuthState();
  if (!auth.authenticated) {
    return { ...base, kind: "auth", version, reason: auth.reason };
  }

  const appServerFailure = cli.appServer && probeFailure("Codex app-server", cli.appServer);
  if (appServerFailure) {
    return { ...base, version, reason: appServerFailure, detail: cli.appServer && firstOutputLine(cli.appServer.stdout, cli.appServer.stderr) };
  }

  const warning = managedSourceWarning("codex", source);
  const sandboxHealth = getCodexLinuxSandboxHealth();
  const warnings = [warning, sandboxHealth?.available === false ? sandboxHealth.reason : undefined]
    .filter((value): value is string => !!value);
  return {
    ...base,
    available: true,
    severity: warnings.length > 0 ? "warning" : "ok",
    version,
    reason: warnings.length > 0 ? warnings.join(" ") : undefined,
    detail: sandboxHealth?.available === false ? sandboxHealth.detail : undefined,
  };
}

function claudeHealth(): BackendHealthInfo | undefined {
  const info = getClaudeExecutableInfo();
  if (!info.path) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      kind: "install",
      source: info.source,
      reason: info.reason || "No Claude executable is available.",
      installRoot: managedNpmPrefix(),
    };
  }

  const availability = claudeCliProbe.peek();
  if (!availability) return undefined;
  if (!availability.available) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      kind: "launch",
      source: info.source,
      command: info.path,
      reason: availability.reason || "Claude executable is not launchable.",
      detail: availability.detail,
      installRoot: managedNpmPrefix(),
    };
  }

  // A launchable Claude says nothing about whether it is signed in, so the
  // saved credential is the only pre-turn signal that the user is logged out.
  const auth = readClaudeAuthState();
  if (!auth.authenticated) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      kind: "auth",
      source: info.source,
      command: info.path,
      version: availability.version,
      reason: auth.reason,
      installRoot: managedNpmPrefix(),
    };
  }

  const warning = managedSourceWarning("claude", info.source);
  return {
    backend: "claude",
    enabled: true,
    available: true,
    severity: warning ? "warning" : "ok",
    source: info.source,
    command: info.path,
    version: availability.version,
    reason: warning,
    installRoot: managedNpmPrefix(),
  };
}

export function loadServerSettings(): ServerSettings {
  if (cachedSettings) return cachedSettings;
  ensureStoreDir();
  if (!fs.existsSync(SETTINGS_FILE)) {
    cachedSettings = {
      codexDriver: DEFAULT_CODEX_DRIVER,
      defaultCwd: BOOT_DEFAULT_CWD,
      systemPrompt: "",
      systemPromptInitialized: false,
      claudeAutoCompactWindow: DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
      claudeAutoCompactWindowConfigured: false,
      sentFileRetentionDays: DEFAULT_SENT_FILE_RETENTION_DAYS,
    };
    return cachedSettings;
  }

  try {
    const raw = parseJsonObject(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    const rawClaudeAutoCompactWindow = raw.claudeAutoCompactWindow;
    cachedSettings = {
      codexDriver: normalizeDriver(raw.codexDriver),
      defaultCwd: normalizeDefaultCwd(raw.defaultCwd),
      systemPrompt: normalizeSystemPrompt(raw.systemPrompt),
      systemPromptInitialized: raw.systemPromptInitialized === true,
      claudeAutoCompactWindow: resolvePersistedClaudeAutoCompactWindow(
        rawClaudeAutoCompactWindow,
        raw.claudeAutoCompactWindowConfigured,
      ),
      claudeAutoCompactWindowConfigured:
        raw.claudeAutoCompactWindowConfigured === true
        || (
          rawClaudeAutoCompactWindow !== undefined
          && rawClaudeAutoCompactWindow !== null
          && rawClaudeAutoCompactWindow !== ""
        ),
      sentFileRetentionDays: (() => {
        try {
          return normalizeSentFileRetentionDays(raw.sentFileRetentionDays);
        } catch {
          return DEFAULT_SENT_FILE_RETENTION_DAYS;
        }
      })(),
    };
  } catch (err: unknown) {
    console.warn(`[settings] Failed to read server settings: ${errorMessage(err)}`);
    cachedSettings = {
      codexDriver: DEFAULT_CODEX_DRIVER,
      defaultCwd: BOOT_DEFAULT_CWD,
      systemPrompt: "",
      systemPromptInitialized: false,
      claudeAutoCompactWindow: DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
      claudeAutoCompactWindowConfigured: false,
      sentFileRetentionDays: DEFAULT_SENT_FILE_RETENTION_DAYS,
    };
  }
  return cachedSettings;
}

export function saveServerSettings(settings: ServerSettings): ServerSettings {
  ensureStoreDir();
  const previous = loadServerSettings();
  cachedSettings = {
    codexDriver: normalizeDriver(settings.codexDriver ?? previous.codexDriver),
    defaultCwd: normalizeDefaultCwd(settings.defaultCwd ?? previous.defaultCwd),
    systemPrompt: normalizeSystemPrompt(settings.systemPrompt ?? previous.systemPrompt),
    systemPromptInitialized: settings.systemPromptInitialized ?? previous.systemPromptInitialized,
    claudeAutoCompactWindow: settings.claudeAutoCompactWindow === undefined
      ? previous.claudeAutoCompactWindow
      : normalizeClaudeAutoCompactWindow(settings.claudeAutoCompactWindow),
    claudeAutoCompactWindowConfigured:
      settings.claudeAutoCompactWindowConfigured
      ?? previous.claudeAutoCompactWindowConfigured
      ?? false,
    sentFileRetentionDays: normalizeSentFileRetentionDays(
      settings.sentFileRetentionDays ?? previous.sentFileRetentionDays,
    ),
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cachedSettings, null, 2), "utf-8");
  return cachedSettings;
}

export function setDefaultCwd(defaultCwd: string): ServerSettings {
  return saveServerSettings({ ...loadServerSettings(), defaultCwd: normalizeDefaultCwd(defaultCwd) });
}

export function getDefaultCwd(): string {
  return loadServerSettings().defaultCwd;
}

export function setServerSystemPrompt(systemPrompt: string): ServerSettings {
  return saveServerSettings({
    ...loadServerSettings(),
    systemPrompt: normalizeSystemPrompt(systemPrompt),
    systemPromptInitialized: true,
  });
}

export function getServerSystemPrompt(): string {
  return loadServerSettings().systemPrompt;
}

export function isServerSystemPromptInitialized(): boolean {
  return loadServerSettings().systemPromptInitialized;
}

export function setSentFileRetentionDays(days: number): ServerSettings {
  return saveServerSettings({ ...loadServerSettings(), sentFileRetentionDays: normalizeSentFileRetentionDays(days) });
}

export function getSentFileRetentionDays(): number {
  return loadServerSettings().sentFileRetentionDays;
}

export function setClaudeAutoCompactWindow(window: number | null): ServerSettings {
  return saveServerSettings({
    ...loadServerSettings(),
    claudeAutoCompactWindow: normalizeClaudeAutoCompactWindow(window),
    claudeAutoCompactWindowConfigured: true,
  });
}

export function getClaudeAutoCompactWindow(): number | null {
  return loadServerSettings().claudeAutoCompactWindow;
}

export function getCodexDriversAvailable(): CodexDriver[] {
  const cli = codexCliProbe.peek();
  if (cli?.appServer?.status !== 0) return [];
  const authPath = path.join(process.env.HOME || os.homedir(), ".codex", "auth.json");
  return fs.existsSync(authPath) ? ["app-server"] : [];
}

/**
 * Backend health from the last finished probes. It never waits: a backend is
 * left out until its first probe finishes, and listeners hear when it does.
 */
export function getBackendHealth(): BackendHealthInfo[] {
  const now = Date.now();
  if (cachedBackendHealth && now - cachedBackendHealth.checkedAt < BACKEND_HEALTH_CACHE_MS) {
    return cachedBackendHealth.value;
  }

  const codexCli = codexCliProbe.peek();
  const derived: Array<[Backend, BackendHealthInfo | undefined]> = [
    ["claude", claudeHealth()],
    ["codex", codexCli && codexHealth(codexCli)],
  ];
  const value = derived
    .map(([backend, entry]) => backendHealthOverrides.get(backend) ?? entry)
    .filter((entry): entry is BackendHealthInfo => entry !== undefined);
  cachedBackendHealth = { checkedAt: Date.now(), value };
  return value;
}

export function getAdvertisedServerSettings(): ServerSettings & {
  codexDriversAvailable: CodexDriver[];
  backendHealth: BackendHealthInfo[];
  issues: ComputerIssue[];
} {
  const settings = loadServerSettings();
  const codexDriversAvailable = getCodexDriversAvailable();
  return {
    codexDriver: DEFAULT_CODEX_DRIVER,
    defaultCwd: settings.defaultCwd,
    systemPrompt: settings.systemPrompt,
    systemPromptInitialized: settings.systemPromptInitialized,
    claudeAutoCompactWindow: settings.claudeAutoCompactWindow,
    sentFileRetentionDays: settings.sentFileRetentionDays,
    codexDriversAvailable,
    backendHealth: getBackendHealth(),
    issues: getComputerIssues(),
  };
}
