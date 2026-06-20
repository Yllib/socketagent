import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { matchProtectedPath } from "./protected-files";

export type FileManagerEntryKind = "directory" | "file" | "symlink" | "other";
export type FileManagerMediaKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "archive"
  | "code"
  | "other";

export interface FileManagerEntry {
  name: string;
  path: string;
  kind: FileManagerEntryKind;
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  extension?: string;
  mimeType?: string;
  mediaKind?: FileManagerMediaKind;
  protected: boolean;
  protectedLabel?: string;
}

export interface FileManagerRoot {
  label: string;
  path: string;
}

export interface FileManagerListing {
  path: string;
  parentPath?: string;
  entries: FileManagerEntry[];
  roots: FileManagerRoot[];
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".log",
  ".env", ".gitignore", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
]);
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".dart", ".py", ".rs",
  ".go", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".rb", ".lua", ".sql", ".html", ".css", ".scss",
]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"]);

function uniqueRoots(roots: FileManagerRoot[]): FileManagerRoot[] {
  const seen = new Set<string>();
  const out: FileManagerRoot[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ label: root.label, path: resolved });
  }
  return out;
}

export function getFileManagerRoots(defaultCwd: string): FileManagerRoot[] {
  const configured = (process.env.FILE_MANAGER_ROOTS || "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i) => ({ label: `Root ${i + 1}`, path: p }));
  if (configured.length > 0) return uniqueRoots(configured);

  return uniqueRoots([
    { label: "Home", path: os.homedir() },
    { label: "Default", path: defaultCwd },
  ]);
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOrResolved(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function policyPathFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) {
    return realpathOrResolved(resolved);
  }

  const missingParts: string[] = [];
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingParts.unshift(path.basename(current));
    current = parent;
  }

  return path.join(realpathOrResolved(current), ...missingParts);
}

export function assertFileManagerPathAllowed(resolvedPath: string, roots: FileManagerRoot[]): void {
  if (process.env.FILE_MANAGER_ALLOW_ABSOLUTE === "true") return;
  const policyPath = policyPathFor(resolvedPath);
  const allowed = roots.some((root) => isPathInside(policyPath, realpathOrResolved(root.path)));
  if (!allowed) {
    throw new Error(`Path is outside allowed file manager roots: ${resolvedPath}`);
  }
}

export function resolveFileManagerPath(inputPath: string | undefined, defaultCwd: string): string {
  if (!inputPath || inputPath.trim() === "") return path.resolve(defaultCwd);
  return path.resolve(inputPath);
}

function classifyMedia(ext: string): FileManagerMediaKind {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.has(lower)) return "image";
  if (VIDEO_EXTENSIONS.has(lower)) return "video";
  if (AUDIO_EXTENSIONS.has(lower)) return "audio";
  if (ARCHIVE_EXTENSIONS.has(lower)) return "archive";
  if (CODE_EXTENSIONS.has(lower)) return "code";
  if (TEXT_EXTENSIONS.has(lower)) return "text";
  return "other";
}

function mimeForExtension(ext: string): string | undefined {
  const lower = ext.toLowerCase();
  if (lower === ".jpg" || lower === ".jpeg") return "image/jpeg";
  if (lower === ".png") return "image/png";
  if (lower === ".gif") return "image/gif";
  if (lower === ".webp") return "image/webp";
  if (lower === ".mp4") return "video/mp4";
  if (lower === ".webm") return "video/webm";
  if (lower === ".mp3") return "audio/mpeg";
  if (lower === ".wav") return "audio/wav";
  if (lower === ".json") return "application/json";
  if (TEXT_EXTENSIONS.has(lower) || CODE_EXTENSIONS.has(lower)) return "text/plain";
  return undefined;
}

function entryKind(dirent: fs.Dirent): FileManagerEntryKind {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

export function listFileManagerDirectory(args: {
  dirPath?: string;
  includeHidden?: boolean;
  defaultCwd: string;
}): FileManagerListing {
  const roots = getFileManagerRoots(args.defaultCwd);
  const resolvedPath = resolveFileManagerPath(args.dirPath, args.defaultCwd);
  assertFileManagerPathAllowed(resolvedPath, roots);

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedPath}`);
  }

  const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
    .filter((entry) => args.includeHidden || !entry.name.startsWith("."))
    .map((entry): FileManagerEntry => {
      const fullPath = path.join(resolvedPath, entry.name);
      const kind = entryKind(entry);
      let itemStat: fs.Stats | null = null;
      try {
        itemStat = fs.lstatSync(fullPath);
      } catch {
        itemStat = null;
      }
      const ext = kind === "directory" ? "" : path.extname(entry.name);
      const protectedMatch = matchProtectedPath(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        kind,
        hidden: entry.name.startsWith("."),
        ...(itemStat ? { size: itemStat.size, modifiedAt: itemStat.mtime.toISOString() } : {}),
        ...(ext ? { extension: ext } : {}),
        ...(ext ? { mediaKind: classifyMedia(ext), mimeType: mimeForExtension(ext) } : { mediaKind: kind === "directory" ? "other" : "other" }),
        protected: protectedMatch !== null,
        ...(protectedMatch?.entry.label ? { protectedLabel: protectedMatch.entry.label } : {}),
      };
    })
    .sort((a, b) => {
      if (a.kind === "directory" && b.kind !== "directory") return -1;
      if (a.kind !== "directory" && b.kind === "directory") return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  const parent = path.dirname(resolvedPath);
  const parentAllowed = parent !== resolvedPath && roots.some((root) => isPathInside(parent, root.path));
  return {
    path: resolvedPath,
    ...(parentAllowed || process.env.FILE_MANAGER_ALLOW_ABSOLUTE === "true" ? { parentPath: parent } : {}),
    entries,
    roots,
  };
}
