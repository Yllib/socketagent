import * as fs from "fs";
import type { Backend } from "./protocol";
import { socketAgentDataPath } from "./socket-agent-paths";

export interface CachedModelCatalog {
  models: Array<Record<string, unknown>>;
  updatedAt: string;
}

type StoredModelCatalogs = Partial<Record<Backend, CachedModelCatalog>>;

const MODEL_CATALOG_FILE = socketAgentDataPath("model-catalogs.json");
let memoryCache: StoredModelCatalogs | null = null;

function cloneCatalog(catalog: CachedModelCatalog): CachedModelCatalog {
  return JSON.parse(JSON.stringify(catalog)) as CachedModelCatalog;
}

function readCatalogs(): StoredModelCatalogs {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_CATALOG_FILE, "utf8"));
    memoryCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
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
  const tempFile = `${MODEL_CATALOG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(catalogs, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, MODEL_CATALOG_FILE);
  return cloneCatalog(catalog);
}

export function modelCatalogIsFresh(
  catalog: CachedModelCatalog,
  maxAgeMs = 6 * 60 * 60 * 1000,
): boolean {
  const updatedAt = Date.parse(catalog.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= maxAgeMs;
}
