import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { CodexDriver } from "./protocol";

export interface ServerSettings {
  codexDriver: CodexDriver;
  defaultCwd: string;
}

const STORE_DIR = path.join(process.env.HOME || os.homedir(), ".claude-assistant");
const SETTINGS_FILE = path.join(STORE_DIR, "server-settings.json");
const DEFAULT_CODEX_DRIVER: CodexDriver = "app-server";
const BOOT_DEFAULT_CWD = path.resolve(process.env.DEFAULT_CWD || process.cwd());

let cachedSettings: ServerSettings | null = null;
let cachedDriversAvailable: CodexDriver[] | null = null;

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
  if (cachedDriversAvailable) return cachedDriversAvailable;
  const codexProbe = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (codexProbe.status !== 0) {
    cachedDriversAvailable = [];
    return cachedDriversAvailable;
  }

  const authPath = path.join(process.env.HOME || os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    cachedDriversAvailable = [];
    return cachedDriversAvailable;
  }

  const drivers: CodexDriver[] = ["exec"];
  try {
    const result = spawnSync("codex", ["app-server", "--help"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status === 0) drivers.push("app-server");
  } catch {
    // Leave app-server absent; exec remains the stable fallback.
  }
  cachedDriversAvailable = drivers;
  return cachedDriversAvailable;
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
