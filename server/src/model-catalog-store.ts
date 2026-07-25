import * as fs from "fs";
import type { Backend } from "./protocol";
import { socketAgentDataPath } from "./socket-agent-paths";

export interface CachedModelCatalog {
  models: Array<Record<string, unknown>>;
  updatedAt: string;
}

type StoredModelCatalogs = Partial<Record<Backend, CachedModelCatalog>>;

const MODEL_CATALOG_FILE = socketAgentDataPath("model-catalogs.json");
const MODEL_CATALOG_SCHEMA_VERSION = 2;
let memoryCache: StoredModelCatalogs | null = null;

function cloneCatalog(catalog: CachedModelCatalog): CachedModelCatalog {
  return JSON.parse(JSON.stringify(catalog)) as CachedModelCatalog;
}

function readCatalogs(): StoredModelCatalogs {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_CATALOG_FILE, "utf8"));
    memoryCache = parsed
      && typeof parsed === "object"
      && parsed.schemaVersion === MODEL_CATALOG_SCHEMA_VERSION
      && parsed.catalogs
      && typeof parsed.catalogs === "object"
      ? parsed.catalogs
      : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
}

function writeCatalogs(catalogs: StoredModelCatalogs): void {
  const tempFile = `${MODEL_CATALOG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify({
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    catalogs,
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, MODEL_CATALOG_FILE);
}

export function getCachedModelCatalog(backend: Backend): CachedModelCatalog | undefined {
  const catalog = readCatalogs()[backend];
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return undefined;
  return cloneCatalog(catalog);
}

export function saveCachedModelCatalog(
  backend: Backend,
  models: Array<Record<string, unknown>>,
  updatedAt = new Date().toISOString(),
): CachedModelCatalog {
  const catalog = { models: JSON.parse(JSON.stringify(models)), updatedAt } as CachedModelCatalog;
  const catalogs = readCatalogs();
  catalogs[backend] = catalog;
  writeCatalogs(catalogs);
  return cloneCatalog(catalog);
}

export function invalidateCachedModelCatalog(backend: Backend): void {
  const catalogs = readCatalogs();
  if (!catalogs[backend]) return;
  delete catalogs[backend];
  writeCatalogs(catalogs);
}

export function modelCatalogIsFresh(
  catalog: CachedModelCatalog,
  maxAgeMs = 6 * 60 * 60 * 1000,
): boolean {
  const updatedAt = Date.parse(catalog.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= maxAgeMs;
}
