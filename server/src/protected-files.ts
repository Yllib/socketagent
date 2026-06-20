import * as fs from "fs";
import * as path from "path";

export interface ProtectedFileEntry {
  path: string;
  label?: string;
}

export interface ProtectedFileMatch {
  entry: ProtectedFileEntry;
}

export const PROTECTED_FILES_CONFIG = path.join(
  process.env.HOME || "/home/rdp",
  ".socketagent",
  "protected-files.json"
);

export function readProtectedFiles(): ProtectedFileEntry[] {
  try {
    if (!fs.existsSync(PROTECTED_FILES_CONFIG)) return [];
    const raw = fs.readFileSync(PROTECTED_FILES_CONFIG, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry) => entry && typeof entry.path === "string")
      : [];
  } catch (err: any) {
    console.error(`[protected-files] Failed to read config: ${err.message || err}`);
    return [];
  }
}

export function writeProtectedFiles(entries: ProtectedFileEntry[]): void {
  fs.mkdirSync(path.dirname(PROTECTED_FILES_CONFIG), { recursive: true });
  fs.writeFileSync(PROTECTED_FILES_CONFIG, JSON.stringify(entries, null, 2), "utf-8");
}

export function matchProtectedPath(filePath: string): ProtectedFileMatch | null {
  if (!filePath) return null;
  const normalized = path.resolve(filePath);
  for (const entry of readProtectedFiles()) {
    const pattern = entry.path;

    if (path.resolve(pattern) === normalized) {
      return { entry };
    }

    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      const resolvedDir = path.resolve(dir);
      if (normalized === resolvedDir || normalized.startsWith(resolvedDir + path.sep)) {
        return { entry };
      }
    }

    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1);
      if (normalized.endsWith(suffix)) {
        return { entry };
      }
    }
  }
  return null;
}

export function setProtectedFile(
  filePath: string,
  protect: boolean,
  options: { label?: string; pattern?: "exact" | "directory" } = {},
): { entries: ProtectedFileEntry[]; entry?: ProtectedFileEntry; removed?: ProtectedFileEntry } {
  const resolved = path.resolve(filePath);
  const entryPath = options.pattern === "directory"
    ? `${resolved.replace(/[\\/]$/, "")}/**`
    : resolved;
  const entries = readProtectedFiles();
  const without = entries.filter((entry) => entry.path !== entryPath);

  if (!protect) {
    writeProtectedFiles(without);
    return { entries: without };
  }

  const entry: ProtectedFileEntry = {
    path: entryPath,
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  };
  const next = [...without, entry];
  writeProtectedFiles(next);
  return { entries: next, entry };
}

export function removeMatchingProtection(filePath: string): { entries: ProtectedFileEntry[]; entry?: ProtectedFileEntry; removed?: ProtectedFileEntry } {
  const match = matchProtectedPath(filePath);
  if (!match) return { entries: readProtectedFiles() };
  const entries = readProtectedFiles().filter((entry) => entry.path !== match.entry.path);
  writeProtectedFiles(entries);
  return { entries, removed: match.entry };
}
