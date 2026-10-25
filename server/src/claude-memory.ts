import * as fs from "fs";
import * as path from "path";
import { claudeConfigDir } from "./backend-config-files";
import type { MemoryCard, MemoryChange } from "./protocol";

/**
 * Claude Code's auto-memory: one Markdown file per memory under
 * `<claude config>/projects/<project slug>/memory/`, indexed by `MEMORY.md`
 * in the same folder. Claude writes them with Write, Edit or a shell command,
 * so the session compares the folder before and after each tool call instead
 * of watching any one tool.
 */

export const MEMORY_INDEX_FILE = "MEMORY.md";
const MAX_MEMORY_BYTES = 1024 * 1024;

/** Claude Code's project folder name: every non-alphanumeric character becomes a dash. */
export function claudeProjectSlug(cwd: string): string {
  let dir = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (dir.length > 200) {
    let hash = 0;
    for (let i = 0; i < cwd.length; i++) {
      hash = (hash << 5) - hash + cwd.charCodeAt(i);
      hash |= 0;
    }
    dir = dir.slice(0, 200) + "-" + Math.abs(hash).toString(36);
  }
  return dir;
}

export function claudeProjectsRoot(): string {
  return path.join(claudeConfigDir(), "projects");
}

/** The memory folder for a session that started in `cwd`. */
export function claudeMemoryDir(cwd: string): string {
  return path.join(claudeProjectsRoot(), claudeProjectSlug(cwd), "memory");
}

export interface ParsedMemory {
  name: string;
  description: string;
  memoryType: string;
  body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Splits a memory file into its frontmatter fields and body. The frontmatter
 * is the small fixed YAML Claude writes (name, description, metadata.type);
 * a file without one is all body and takes its name from the file.
 */
export function parseMemoryFile(fileName: string, text: string): ParsedMemory {
  const fallbackName = fileName.replace(/\.md$/i, "");
  const parsed: ParsedMemory = { name: fallbackName, description: "", memoryType: "", body: text.trim() };
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return parsed;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return parsed;
  const frontmatter = normalized.slice(4, end).split("\n");
  let afterClose = end + 4;
  if (normalized[afterClose] === "\n") afterClose += 1;
  parsed.body = normalized.slice(afterClose).trim();
  for (const line of frontmatter) {
    const topLevel = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (topLevel) {
      const [, key, value] = topLevel;
      if (key === "name" && value.trim()) parsed.name = unquote(value);
      else if (key === "description") parsed.description = unquote(value);
      else if (key === "type") parsed.memoryType = unquote(value);
      continue;
    }
    const nested = /^\s+type:\s*(.*)$/.exec(line);
    if (nested) parsed.memoryType = unquote(nested[1]);
  }
  return parsed;
}

export function memoryCardFor(filePath: string, text: string, change: MemoryChange): MemoryCard {
  const parsed = parseMemoryFile(path.basename(filePath), text);
  return { path: filePath, ...parsed, change };
}

/** Memory file names and contents, without the index. Missing folder means no memories. */
export function snapshotMemoryDir(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return snapshot;
  }
  for (const entry of entries) {
    // Dirent does not follow symlinks, so a linked file is not a memory.
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === MEMORY_INDEX_FILE) continue;
    try {
      const filePath = path.join(dir, entry.name);
      if (fs.statSync(filePath).size > MAX_MEMORY_BYTES) continue;
      snapshot.set(entry.name, fs.readFileSync(filePath, "utf8"));
    } catch {}
  }
  return snapshot;
}

export function diffMemorySnapshots(dir: string, before: Map<string, string>, after: Map<string, string>): MemoryCard[] {
  const cards: MemoryCard[] = [];
  for (const [name, text] of after) {
    const previous = before.get(name);
    if (previous === undefined) cards.push(memoryCardFor(path.join(dir, name), text, "created"));
    else if (previous !== text) cards.push(memoryCardFor(path.join(dir, name), text, "edited"));
  }
  for (const [name, text] of before) {
    if (!after.has(name)) cards.push(memoryCardFor(path.join(dir, name), text, "deleted"));
  }
  return cards.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Tracks one session's memory folder across tool calls. `prime` takes the
 * first baseline before a tool runs; `collect` reports what changed since the
 * last look and makes that the new baseline, so two tools running at once
 * report each change exactly once.
 */
export class ClaudeMemoryWatcher {
  private baseline?: Map<string, string>;

  constructor(readonly dir: string) {}

  prime(): void {
    if (!this.baseline) this.baseline = snapshotMemoryDir(this.dir);
  }

  /** Forget changes made outside the agent, such as an edit from the card. */
  reset(): void {
    this.baseline = snapshotMemoryDir(this.dir);
  }

  collect(): MemoryCard[] {
    const after = snapshotMemoryDir(this.dir);
    const before = this.baseline;
    this.baseline = after;
    if (!before) return [];
    return diffMemorySnapshots(this.dir, before, after);
  }
}

/**
 * Accepts only `<projects root>/<slug>/memory/<name>.md`, never the index, and
 * refuses any path whose folder resolves outside that root through a symlink.
 * The returned path is the normalized one the caller should use.
 */
export function resolveMemoryFilePath(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error("Memory path required");
  const resolved = path.resolve(input.trim());
  const projectsRoot = claudeProjectsRoot();
  const relative = path.relative(projectsRoot, resolved);
  const parts = relative.split(path.sep);
  const [slug, folder, fileName] = parts;
  if (
    relative.startsWith("..") || path.isAbsolute(relative) || parts.length !== 3
    || !slug || slug === "." || folder !== "memory" || !fileName
    || !fileName.endsWith(".md") || fileName === MEMORY_INDEX_FILE
  ) {
    throw new Error("Not a Claude memory file");
  }
  const realRoot = fs.realpathSync(projectsRoot);
  let realDir: string;
  try {
    realDir = fs.realpathSync(path.dirname(resolved));
  } catch {
    throw new Error("Memory folder not found");
  }
  if (realDir !== path.join(realRoot, slug, "memory")) throw new Error("Memory folder is a link outside Claude's projects");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ENOENT") return resolved;
    throw error;
  }
  if (!stat.isFile()) throw new Error("Not a regular memory file");
  return resolved;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function readMemoryFile(input: unknown): { path: string; content: string } {
  const filePath = resolveMemoryFilePath(input);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_MEMORY_BYTES) throw new Error("Memory file is too large to edit here");
  return { path: filePath, content: fs.readFileSync(filePath, "utf8") };
}

export function writeMemoryFile(input: unknown, content: string): { path: string; card: MemoryCard } {
  const filePath = resolveMemoryFilePath(input);
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) throw new Error("Memory file is too large");
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, card: memoryCardFor(filePath, content, "edited") };
}

/** Drops the index lines that link to `fileName`. Other lines stay byte for byte. */
export function memoryIndexWithout(indexText: string, fileName: string): string {
  const target = fileName.toLowerCase();
  return indexText
    .split("\n")
    .filter((line) => {
      const link = /\]\(\.?\/?([^)]+)\)/.exec(line);
      return !link || decodeURIComponent(link[1]).toLowerCase() !== target;
    })
    .join("\n");
}

/** Removes the memory and its `MEMORY.md` line in one step. */
export function deleteMemoryFile(input: unknown): { path: string; indexUpdated: boolean } {
  const filePath = resolveMemoryFilePath(input);
  if (!fs.existsSync(filePath)) throw new Error("Memory file is already gone");
  fs.unlinkSync(filePath);
  const indexPath = path.join(path.dirname(filePath), MEMORY_INDEX_FILE);
  let indexUpdated = false;
  try {
    const before = fs.readFileSync(indexPath, "utf8");
    const after = memoryIndexWithout(before, path.basename(filePath));
    if (after !== before) {
      fs.writeFileSync(indexPath, after, "utf8");
      indexUpdated = true;
    }
  } catch (error: unknown) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) throw error;
  }
  return { path: filePath, indexUpdated };
}
