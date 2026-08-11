import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { matchProtectedPath } from "./protected-files";
import { checkMacosFileAccess, isMacosProtectedUserPath } from "./macos-permissions";

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
  offset?: number;
  limit?: number;
  totalCount?: number;
  nextOffset?: number;
  hasMore?: boolean;
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
const DIRECTORY_READ_TIMEOUT_MS = 8_000;
const LEGACY_DIRECTORY_ENTRY_LIMIT = 2_000;

function withFilesystemTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${DIRECTORY_READ_TIMEOUT_MS / 1000} seconds`));
    }, DIRECTORY_READ_TIMEOUT_MS);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function readDirectoryEntries(dirPath: string): Promise<fs.Dirent[]> {
  return withFilesystemTimeout(
    fs.promises.readdir(dirPath, { withFileTypes: true }),
    `Listing ${dirPath}`,
  );
}

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

  const filesystemRoot = path.parse(os.homedir()).root || path.parse(defaultCwd).root || path.sep;
  return uniqueRoots([
    { label: "Filesystem", path: filesystemRoot },
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

export function writeFileManagerText(args: {
  filePath: string;
  content: string;
  defaultCwd: string;
  maxBytes?: number;
}): { path: string; bytesWritten: number } {
  const roots = getFileManagerRoots(args.defaultCwd);
  const resolved = resolveFileManagerPath(args.filePath, args.defaultCwd);
  assertFileManagerPathAllowed(resolved, roots);
  const byteLength = Buffer.byteLength(args.content, "utf8");
  const maxBytes = args.maxBytes ?? 1024 * 1024;
  if (byteLength > maxBytes) {
    throw new Error(`Text files are limited to ${maxBytes} bytes`);
  }
  const parent = path.dirname(resolved);
  const parentStat = fs.statSync(parent);
  if (!parentStat.isDirectory()) {
    throw new Error(`Parent is not a directory: ${parent}`);
  }
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  fs.writeFileSync(resolved, args.content, { encoding: "utf8", mode: 0o600 });
  return { path: resolved, bytesWritten: byteLength };
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

function entryKind(entry: fs.Dirent | fs.Stats): FileManagerEntryKind {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function compareDirectoryEntries(a: fs.Dirent, b: fs.Dirent): number {
  const aDirectory = a.isDirectory();
  const bDirectory = b.isDirectory();
  if (aDirectory && !bDirectory) return -1;
  if (!aDirectory && bDirectory) return 1;
  const folded = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return folded !== 0 ? folded : a.name.localeCompare(b.name);
}

function fileManagerEntry(
  fullPath: string,
  kind: FileManagerEntryKind,
  itemStat: fs.Stats | null,
): FileManagerEntry {
  const name = path.basename(fullPath);
  const ext = kind === "directory" ? "" : path.extname(name);
  const protectedMatch = matchProtectedPath(fullPath);
  return {
    name,
    path: fullPath,
    kind,
    hidden: name.startsWith("."),
    ...(itemStat ? { size: itemStat.size, modifiedAt: itemStat.mtime.toISOString() } : {}),
    ...(ext ? { extension: ext } : {}),
    mediaKind: ext ? classifyMedia(ext) : "other",
    ...(ext ? { mimeType: mimeForExtension(ext) } : {}),
    protected: protectedMatch !== null,
    ...(protectedMatch?.entry.label ? { protectedLabel: protectedMatch.entry.label } : {}),
  };
}

/** Returns metadata for exactly one path without enumerating its parent directory. */
export async function statFileManagerPath(args: {
  filePath: string;
  defaultCwd: string;
}): Promise<FileManagerEntry> {
  const roots = getFileManagerRoots(args.defaultCwd);
  const resolvedPath = resolveFileManagerPath(args.filePath, args.defaultCwd);
  assertFileManagerPathAllowed(resolvedPath, roots);

  if (isMacosProtectedUserPath(resolvedPath)) {
    const access = await checkMacosFileAccess(resolvedPath);
    if (access.access !== "granted") {
      const denied = new Error(access.error || `macOS denied access to ${resolvedPath}`) as NodeJS.ErrnoException;
      denied.code = "EPERM";
      throw denied;
    }
  }

  const stat = await withFilesystemTimeout(
    fs.promises.lstat(resolvedPath),
    `Reading ${resolvedPath}`,
  );
  return fileManagerEntry(resolvedPath, entryKind(stat), stat);
}

export async function listFileManagerDirectory(args: {
  dirPath?: string;
  includeHidden?: boolean;
  defaultCwd: string;
  /** Omit for compatibility with older clients that expect a complete listing. */
  offset?: number;
  limit?: number;
  /** When paginating, begin with the page containing this exact child path. */
  anchorPath?: string;
}): Promise<FileManagerListing> {
  const roots = getFileManagerRoots(args.defaultCwd);
  const resolvedPath = resolveFileManagerPath(args.dirPath, args.defaultCwd);
  assertFileManagerPathAllowed(resolvedPath, roots);

  if (isMacosProtectedUserPath(resolvedPath)) {
    const access = await checkMacosFileAccess(resolvedPath);
    if (access.access !== "granted") {
      const denied = new Error(access.error || `macOS denied access to ${resolvedPath}`) as NodeJS.ErrnoException;
      denied.code = "EPERM";
      throw denied;
    }
  }

  const stat = await withFilesystemTimeout(
    fs.promises.stat(resolvedPath),
    `Reading ${resolvedPath}`,
  );
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedPath}`);
  }

  const dirEntries = (await readDirectoryEntries(resolvedPath))
    .filter((entry) => args.includeHidden || !entry.name.startsWith("."))
    .sort(compareDirectoryEntries);
  const requestedLimit = Number(args.limit);
  const paginated = Number.isSafeInteger(requestedLimit) && requestedLimit > 0;
  if (!paginated && dirEntries.length > LEGACY_DIRECTORY_ENTRY_LIMIT) {
    throw new Error(
      `Directory contains ${dirEntries.length} entries; paginated listing is required`,
    );
  }
  const limit = paginated ? Math.min(requestedLimit, 500) : dirEntries.length;
  let offset = paginated && Number.isSafeInteger(args.offset) && Number(args.offset) >= 0
    ? Number(args.offset)
    : 0;
  if (paginated && args.anchorPath) {
    const resolvedAnchor = resolveFileManagerPath(args.anchorPath, args.defaultCwd);
    if (path.dirname(resolvedAnchor) === resolvedPath) {
      const anchorIndex = dirEntries.findIndex(
        (entry) => path.join(resolvedPath, entry.name) === resolvedAnchor,
      );
      if (anchorIndex >= 0) offset = Math.floor(anchorIndex / limit) * limit;
    }
  }
  offset = Math.min(offset, dirEntries.length);
  const pageEntries = paginated ? dirEntries.slice(offset, offset + limit) : dirEntries;
  const entries = (await withFilesystemTimeout(
    Promise.all(pageEntries.map(async (entry): Promise<FileManagerEntry> => {
      const fullPath = path.join(resolvedPath, entry.name);
      const kind = entryKind(entry);
      let itemStat: fs.Stats | null = null;
      try {
        itemStat = await fs.promises.lstat(fullPath);
      } catch {
        itemStat = null;
      }
      return fileManagerEntry(fullPath, kind, itemStat);
    })),
    `Reading entries in ${resolvedPath}`,
  ));

  const parent = path.dirname(resolvedPath);
  const parentAllowed = parent !== resolvedPath && roots.some((root) => isPathInside(parent, root.path));
  return {
    path: resolvedPath,
    ...(parentAllowed || process.env.FILE_MANAGER_ALLOW_ABSOLUTE === "true" ? { parentPath: parent } : {}),
    entries,
    roots,
    ...(paginated ? {
      offset,
      limit,
      totalCount: dirEntries.length,
      ...(offset + entries.length < dirEntries.length ? { nextOffset: offset + entries.length } : {}),
      hasMore: offset + entries.length < dirEntries.length,
    } : {}),
  };
}
