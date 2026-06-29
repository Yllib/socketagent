import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { Backend, BackendHealthInfo, CodexDriver } from "./protocol";
import { buildCodexSpawn } from "./codex-env";
import { resolveClientPath } from "./path-utils";
import { getClaudeAvailability, getClaudeExecutableInfo } from "./claude-session";
import {
  legacyManagedNpmBinDir,
  managedNpmBinDir,
  managedNpmPrefix,
  socketAgentDataPath,
} from "./socket-agent-paths";

export interface ServerSettings {
  codexDriver: CodexDriver;
  defaultCwd: string;
}

const STORE_DIR = socketAgentDataPath();
const SETTINGS_FILE = path.join(STORE_DIR, "server-settings.json");
const DEFAULT_CODEX_DRIVER: CodexDriver = "app-server";
const BOOT_DEFAULT_CWD = resolveClientPath(process.env.DEFAULT_CWD || process.cwd()).resolvedPath || path.resolve(process.cwd());
const CODEX_DRIVER_CACHE_MS = 5000;
const BACKEND_HEALTH_CACHE_MS = 10000;

let cachedSettings: ServerSettings | null = null;
let cachedDriversAvailable: { checkedAt: number; value: CodexDriver[] } | null = null;
let cachedBackendHealth: { checkedAt: number; value: BackendHealthInfo[] } | null = null;
const backendHealthOverrides = new Map<Backend, BackendHealthInfo>();

export function invalidateCodexDriverAvailabilityCache(): void {
  cachedDriversAvailable = null;
}

export function invalidateBackendHealthCache(): void {
  cachedBackendHealth = null;
}

export function markBackendAuthRequired(backend: Backend, detail?: string): void {
  const label = backend === "codex" ? "Codex" : "Claude";
  backendHealthOverrides.set(backend, {
    backend,
    enabled: true,
    available: false,
    severity: "error",
    reason: `${label} authentication is invalid or expired. Repair the backend to sign in again.`,
    detail,
  });
  invalidateBackendHealthCache();
}

export function clearBackendHealthOverride(backend: Backend): void {
  if (backendHealthOverrides.delete(backend)) {
    invalidateBackendHealthCache();
  }
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

function enabledBackends(): Set<Backend> {
  const raw = (process.env.ENABLED_BACKENDS || "claude,codex").toLowerCase().trim();
  if (raw === "all" || raw === "both") return new Set<Backend>(["claude", "codex"]);

  const enabled = new Set<Backend>();
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name === "claude" || name === "anthropic") enabled.add("claude");
    if (name === "codex" || name === "openai") enabled.add("codex");
  }
  return enabled.size > 0 ? enabled : new Set<Backend>(["claude", "codex"]);
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

function codexHealth(enabled: boolean): BackendHealthInfo {
  if (!enabled) {
    return {
      backend: "codex",
      enabled: false,
      available: false,
      severity: "disabled",
      reason: "Codex is disabled by ENABLED_BACKENDS.",
    };
  }

  const codexVersion = buildCodexSpawn(["--version"]);
  const source = codexCommandSource(codexVersion.command);
  const base: BackendHealthInfo = {
    backend: "codex",
    enabled: true,
    available: false,
    severity: "error",
    source,
    command: codexVersion.command,
    installRoot: managedNpmPrefix(),
  };

  const versionProbe = spawnSync(codexVersion.command, codexVersion.args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    env: codexVersion.env,
    shell: codexVersion.shell,
  });

  if (versionProbe.error) {
    const code = (versionProbe.error as NodeJS.ErrnoException).code;
    return {
      ...base,
      reason: code === "ENOENT"
        ? "Codex CLI was not found."
        : `Codex CLI probe failed: ${versionProbe.error.message}`,
      detail: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
    };
  }

  if (versionProbe.status !== 0) {
    const detail = firstOutputLine(versionProbe.stdout, versionProbe.stderr);
    return {
      ...base,
      reason: detail
        ? `Codex CLI probe exited ${versionProbe.status}: ${detail}`
        : `Codex CLI probe exited ${versionProbe.status}`,
      detail,
    };
  }

  const authPath = path.join(process.env.HOME || os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return {
      ...base,
      version: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
      reason: "Codex CLI is installed, but ~/.codex/auth.json is missing.",
    };
  }

  const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
  const appServerProbe = spawnSync(appServerHelp.command, appServerHelp.args, {
    encoding: "utf8",
    timeout: 3000,
    env: appServerHelp.env,
    shell: appServerHelp.shell,
  });
  if (appServerProbe.status !== 0 || appServerProbe.error) {
    const detail = appServerProbe.error?.message || firstOutputLine(appServerProbe.stdout, appServerProbe.stderr);
    return {
      ...base,
      version: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
      reason: detail
        ? `Codex app-server probe failed: ${detail}`
        : "Codex app-server probe failed.",
      detail,
    };
  }

  const warning = managedSourceWarning("codex", source);
  return {
    ...base,
    available: true,
    severity: warning ? "warning" : "ok",
    version: firstOutputLine(versionProbe.stdout, versionProbe.stderr),
    reason: warning,
  };
}

function claudeHealth(enabled: boolean): BackendHealthInfo {
  if (!enabled) {
    return {
      backend: "claude",
      enabled: false,
      available: false,
      severity: "disabled",
      reason: "Claude is disabled by ENABLED_BACKENDS.",
    };
  }

  const info = getClaudeExecutableInfo();
  const availability = getClaudeAvailability();
  if (!info.path) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      source: info.source,
      reason: info.reason || "No Claude executable is available.",
      installRoot: managedNpmPrefix(),
    };
  }

  if (!availability.available) {
    return {
      backend: "claude",
      enabled: true,
      available: false,
      severity: "error",
      source: info.source,
      command: info.path,
      reason: availability.reason || "Claude executable is not launchable.",
      detail: availability.detail,
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
    cachedSettings = { codexDriver: DEFAULT_CODEX_DRIVER, defaultCwd: BOOT_DEFAULT_CWD };
    return cachedSettings;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Partial<ServerSettings>;
    cachedSettings = {
      codexDriver: normalizeDriver(raw.codexDriver),
      defaultCwd: normalizeDefaultCwd(raw.defaultCwd),
    };
  } catch (err: any) {
    console.warn(`[settings] Failed to read server settings: ${err?.message || String(err)}`);
    cachedSettings = { codexDriver: DEFAULT_CODEX_DRIVER, defaultCwd: BOOT_DEFAULT_CWD };
  }
  return cachedSettings;
}

export function saveServerSettings(settings: ServerSettings): ServerSettings {
  ensureStoreDir();
  const previous = loadServerSettings();
  cachedSettings = {
    codexDriver: normalizeDriver(settings.codexDriver ?? previous.codexDriver),
    defaultCwd: normalizeDefaultCwd(settings.defaultCwd ?? previous.defaultCwd),
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

export function getCodexDriversAvailable(): CodexDriver[] {
  const now = Date.now();
  if (cachedDriversAvailable && now - cachedDriversAvailable.checkedAt < CODEX_DRIVER_CACHE_MS) {
    return cachedDriversAvailable.value;
  }
  const cache = (value: CodexDriver[]): CodexDriver[] => {
    cachedDriversAvailable = { checkedAt: Date.now(), value };
    return value;
  };

  const codexVersion = buildCodexSpawn(["--version"]);
  const codexProbe = spawnSync(codexVersion.command, codexVersion.args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    env: codexVersion.env,
    shell: codexVersion.shell,
  });
  if (codexProbe.status !== 0) {
    return cache([]);
  }

  const authPath = path.join(process.env.HOME || os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return cache([]);
  }

  try {
    const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
    const result = spawnSync(appServerHelp.command, appServerHelp.args, {
      encoding: "utf8",
      timeout: 3000,
      env: appServerHelp.env,
      shell: appServerHelp.shell,
    });
    return cache(result.status === 0 ? ["app-server"] : []);
  } catch {
    return cache([]);
  }
}

export function getBackendHealth(): BackendHealthInfo[] {
  const now = Date.now();
  if (cachedBackendHealth && now - cachedBackendHealth.checkedAt < BACKEND_HEALTH_CACHE_MS) {
    return cachedBackendHealth.value;
  }

  const enabled = enabledBackends();
  const value = [
    claudeHealth(enabled.has("claude")),
    codexHealth(enabled.has("codex")),
  ].map((entry) => backendHealthOverrides.get(entry.backend) ?? entry);
  cachedBackendHealth = { checkedAt: Date.now(), value };
  return value;
}

export function getAdvertisedServerSettings(): ServerSettings & {
  codexDriversAvailable: CodexDriver[];
  backendHealth: BackendHealthInfo[];
} {
  const settings = loadServerSettings();
  const codexDriversAvailable = getCodexDriversAvailable();
  return {
    codexDriver: DEFAULT_CODEX_DRIVER,
    defaultCwd: settings.defaultCwd,
    codexDriversAvailable,
    backendHealth: getBackendHealth(),
  };
}
