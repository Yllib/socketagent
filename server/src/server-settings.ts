import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { CodexDriver } from "./protocol";
import { buildCodexSpawn } from "./codex-env";

export interface ServerSettings {
  codexDriver: CodexDriver;
  defaultCwd: string;
}

const STORE_DIR = path.join(process.env.HOME || os.homedir(), ".claude-assistant");
const SETTINGS_FILE = path.join(STORE_DIR, "server-settings.json");
const DEFAULT_CODEX_DRIVER: CodexDriver = "app-server";
const BOOT_DEFAULT_CWD = path.resolve(process.env.DEFAULT_CWD || process.cwd());
const CODEX_DRIVER_CACHE_MS = 5000;

let cachedSettings: ServerSettings | null = null;
let cachedDriversAvailable: { checkedAt: number; value: CodexDriver[] } | null = null;

export function invalidateCodexDriverAvailabilityCache(): void {
  cachedDriversAvailable = null;
}

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function normalizeDriver(value: unknown): CodexDriver {
  return value === "app-server" ? "app-server" : "exec";
}

function normalizeDefaultCwd(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return BOOT_DEFAULT_CWD;
  return path.resolve(value.trim());
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

export function setCodexDriver(driver: CodexDriver): ServerSettings {
  return saveServerSettings({ ...loadServerSettings(), codexDriver: normalizeDriver(driver) });
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

  const drivers: CodexDriver[] = ["exec"];
  try {
    const appServerHelp = buildCodexSpawn(["app-server", "--help"]);
    const result = spawnSync(appServerHelp.command, appServerHelp.args, {
      encoding: "utf8",
      timeout: 3000,
      env: appServerHelp.env,
      shell: appServerHelp.shell,
    });
    if (result.status === 0) drivers.push("app-server");
  } catch {
    // Leave app-server absent; exec remains the stable fallback.
  }
  return cache(drivers);
}

export function getAdvertisedServerSettings(): ServerSettings & { codexDriversAvailable: CodexDriver[] } {
  const settings = loadServerSettings();
  const codexDriversAvailable = getCodexDriversAvailable();
  const fallback = codexDriversAvailable.includes(DEFAULT_CODEX_DRIVER) ? DEFAULT_CODEX_DRIVER : "exec";
  return {
    codexDriver: codexDriversAvailable.includes(settings.codexDriver) ? settings.codexDriver : fallback,
    defaultCwd: settings.defaultCwd,
    codexDriversAvailable,
  };
}

export function resolveCodexDriver(driver?: CodexDriver): CodexDriver {
  const requested = driver ? normalizeDriver(driver) : getAdvertisedServerSettings().codexDriver;
  return getCodexDriversAvailable().includes(requested) ? requested : "exec";
}
