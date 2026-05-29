import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { CodexDriver } from "./protocol";

export interface ServerSettings {
  codexDriver: CodexDriver;
}

const STORE_DIR = path.join(process.env.HOME || os.homedir(), ".claude-assistant");
const SETTINGS_FILE = path.join(STORE_DIR, "server-settings.json");

let cachedSettings: ServerSettings | null = null;
let cachedDriversAvailable: CodexDriver[] | null = null;

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function normalizeDriver(value: unknown): CodexDriver {
  return value === "app-server" ? "app-server" : "exec";
}

export function loadServerSettings(): ServerSettings {
  if (cachedSettings) return cachedSettings;
  ensureStoreDir();
  if (!fs.existsSync(SETTINGS_FILE)) {
    cachedSettings = { codexDriver: "exec" };
    return cachedSettings;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Partial<ServerSettings>;
    cachedSettings = {
      codexDriver: normalizeDriver(raw.codexDriver),
    };
  } catch (err: any) {
    console.warn(`[settings] Failed to read server settings: ${err?.message || String(err)}`);
    cachedSettings = { codexDriver: "exec" };
  }
  return cachedSettings;
}

export function saveServerSettings(settings: ServerSettings): ServerSettings {
  ensureStoreDir();
  cachedSettings = {
    codexDriver: normalizeDriver(settings.codexDriver),
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cachedSettings, null, 2), "utf-8");
  return cachedSettings;
}

export function setCodexDriver(driver: CodexDriver): ServerSettings {
  return saveServerSettings({ ...loadServerSettings(), codexDriver: normalizeDriver(driver) });
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
  return {
    codexDriver: codexDriversAvailable.includes(settings.codexDriver) ? settings.codexDriver : "exec",
    codexDriversAvailable,
  };
}
