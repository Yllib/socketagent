import * as fs from "fs";
import * as path from "path";
import { errorCode, errorMessage } from "./value-guards";

/**
 * JSON state files that survive a crash or a power cut mid-write.
 *
 * writeStateFile writes a temporary file, flushes it to disk, keeps the
 * version it replaces as `<file>.bak` and renames the new one into place.
 * Without the flush, NTFS and ext4 can keep the rename and lose the data,
 * which leaves an empty file behind.
 *
 * readStateFile never throws on a bad file. An empty, truncated or invalid
 * file is set aside as `<file>.damaged-<time>` and `<file>.bak` takes its
 * place when that one is good. Either way the caller gets a result and
 * decides what to do, and the computer's issues list shows what happened.
 */

export type StateFileRead<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "damaged"; problem: string };

export interface StateFileIssue {
  file: string;
  severity: "warning" | "error";
  message: string;
}

const issues = new Map<string, StateFileIssue>();
const issueListeners = new Set<() => void>();

/** Problems with state files this process found, for the computer's issues list. */
export function stateFileIssues(): StateFileIssue[] {
  return [...issues.values()];
}

/** Calls [listener] when the list from stateFileIssues changes. */
export function onStateFileIssue(listener: () => void): () => void {
  issueListeners.add(listener);
  return () => issueListeners.delete(listener);
}

/** Puts a problem with [file] on the computer's issues list until the process exits. */
export function reportStateFileIssue(file: string, severity: StateFileIssue["severity"], message: string): void {
  console.error(`[State] ${message}`);
  issues.set(file, { file, severity, message });
  for (const listener of issueListeners) listener();
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows refuses a rename while another process, often antivirus, has
 * either file open. That passes within a second or so.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err: unknown) {
      const code = errorCode(err);
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      sleep(50);
    }
  }
}

function writeSynced(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, "w", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Makes the renames in [dir] durable. Windows has no handle for a directory. */
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Some filesystems refuse fsync on a directory. The data itself is on disk.
  }
}

/**
 * Replaces [file] with [text], keeping the version it replaces as
 * `<file>.bak`. The first write puts [text] in both.
 */
export function writeStateFile(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeSynced(temporary, text);
  if (!fs.existsSync(file)) {
    // A file written once, like the key pair, needs a backup from the start.
    writeSynced(`${file}.bak`, text);
  } else {
    try {
      renameWithRetry(file, `${file}.bak`);
    } catch {
      // Something holds the file open. A copy still gives a backup, and the
      // rename below replaces the file in one step.
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* the write matters more than the backup */ }
    }
  }
  renameWithRetry(temporary, file);
  syncDirectory(dir);
}

function parseText<T>(file: string, parse: (text: string) => T): T {
  const text = fs.readFileSync(file, "utf8");
  // A power cut can leave the file empty, or its old length in zero bytes.
  if (/^[\s\0]*$/.test(text)) throw new Error(text.length === 0 ? "the file is empty" : "the file is blank");
  return parse(text);
}

function damagedName(file: string): string {
  return `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/** Moves a damaged [file] out of the way so the next write starts clean. Returns where it went. */
export function setAsideDamagedFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const target = damagedName(file);
  renameWithRetry(file, target);
  return target;
}

/**
 * Reads [file] with [parse], which throws when the text is not valid.
 *
 * A good file is returned, and copied to `<file>.bak` when there is no
 * backup yet. A missing or damaged file is replaced by its backup when the
 * backup parses. A damaged file with no good backup stays where it is and
 * comes back as `damaged`. The caller reports it and sets it aside, or keeps
 * it as the reason to refuse.
 */
export function readStateFile<T>(file: string, parse: (text: string) => T): StateFileRead<T> {
  const backup = `${file}.bak`;
  let problem: string | undefined;
  if (fs.existsSync(file)) {
    try {
      const value = parseText(file, parse);
      if (!fs.existsSync(backup)) {
        try { writeSynced(backup, fs.readFileSync(file)); } catch { /* the next write makes one */ }
      }
      return { status: "ok", value };
    } catch (err: unknown) {
      problem = errorMessage(err);
    }
  }
  if (!fs.existsSync(backup)) return problem === undefined ? { status: "missing" } : { status: "damaged", problem };
  let value: T;
  try {
    value = parseText(backup, parse);
  } catch (err: unknown) {
    const backupProblem = `its backup is damaged too (${errorMessage(err)})`;
    return { status: "damaged", problem: problem === undefined ? `the file is missing and ${backupProblem}` : `${problem}, and ${backupProblem}` };
  }
  const name = path.basename(file);
  const savedAt = fs.statSync(backup).mtime.toLocaleString();
  const setAside = problem === undefined ? undefined : setAsideDamagedFile(file);
  const temporary = `${file}.${process.pid}.tmp`;
  writeSynced(temporary, fs.readFileSync(backup));
  renameWithRetry(temporary, file);
  syncDirectory(path.dirname(file));
  if (problem === undefined) {
    // A write stopped between its two renames. The backup is one change old.
    console.warn(`[State] ${name} was missing, so the backup from ${savedAt} took its place`);
  } else {
    reportStateFileIssue(file, "warning", `${name} was damaged (${problem}), so SocketAgent went back to the copy saved ${savedAt}. Changes made after that are lost. The damaged file is ${setAside}.`);
  }
  return { status: "ok", value };
}
