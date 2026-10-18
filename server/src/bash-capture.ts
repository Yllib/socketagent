import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { insertShellTee } from "./command-capture";

// Live output for Claude's Bash tool. The PreToolUse hook tees each command's
// output into a capture file named after its tool_use_id, and the session
// streams that file to the app while the command runs.

const CAPTURE_DIR = path.join(os.tmpdir(), "socketagent-bash");
const CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Older servers wrote captures straight into /tmp and never removed them.
const LEGACY_DIR = "/tmp";
const LEGACY_PATTERN = /^claude-bash-.+\.log$/;

/** Native path of the capture file for one Bash tool call. */
export function bashCapturePath(toolUseId: string): string {
  const safeId = toolUseId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return path.join(CAPTURE_DIR, `${safeId}.log`);
}

/**
 * The command the hook runs instead of `command`. Same output and exit status
 * as the original, plus a copy of the output in the capture file. When the
 * command pipes through a filter such as `tail`, the stream before the filter
 * is captured too, and `filtered` is true. Bash on Linux, macOS and Git for
 * Windows all ship `tee`; Git Bash reads a Windows path written with forward
 * slashes.
 */
export function wrapBashForCapture(command: string, toolUseId: string): { command: string; filtered: boolean } {
  const capturePath = bashCapturePath(toolUseId);
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(capturePath, "");
  const shellPath = process.platform === "win32" ? capturePath.replace(/\\/g, "/") : capturePath;
  const quoted = `'${shellPath.replace(/'/g, "'\\''")}'`;
  const teed = insertShellTee(command, shellPath);
  // Both tees append, so their writes interleave instead of overwriting.
  return { command: `set -o pipefail; (${teed ?? command}) 2>&1 | tee -a ${quoted}`, filtered: teed !== null };
}

export function removeBashCapture(toolUseId: string): void {
  fs.rm(bashCapturePath(toolUseId), { force: true }, () => {});
}

async function removeOldFiles(dir: string, matches: (name: string) => boolean, cutoffMs: number): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!matches(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.mtimeMs > cutoffMs) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch {
      // Removed by someone else, or not ours to remove.
    }
  }
  return removed;
}

/**
 * Deletes captures older than a day: ones whose command was backgrounded or
 * interrupted before the session could remove them, and the legacy /tmp files.
 */
export async function pruneBashCaptures(now = Date.now()): Promise<number> {
  const cutoffMs = now - CAPTURE_MAX_AGE_MS;
  const current = await removeOldFiles(CAPTURE_DIR, (name) => name.endsWith(".log"), cutoffMs);
  const legacy = process.platform === "win32"
    ? 0
    : await removeOldFiles(LEGACY_DIR, (name) => LEGACY_PATTERN.test(name), cutoffMs);
  return current + legacy;
}

/** Prunes shortly after startup, then hourly. */
export function startBashCapturePruning(): void {
  const run = () => {
    pruneBashCaptures()
      .then((removed) => { if (removed > 0) console.log(`[BashCapture] Removed ${removed} old capture files`); })
      .catch((err: unknown) => console.warn(`[BashCapture] Prune failed: ${String(err)}`));
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

/**
 * The capture file a rewritten command tees into, read back from the command
 * text (Codex reports the command as it ran), or null when it has none.
 */
export function commandCapturePath(command: string): string | null {
  const match = /socketagent-bash[\\/]+([A-Za-z0-9_-]+)\.log/.exec(command);
  return match ? bashCapturePath(match[1]) : null;
}

/**
 * Polls a capture file and passes each new piece of text to `onText`.
 * Handles UTF-8 and the UTF-16LE that Windows PowerShell's Tee-Object writes.
 * Returns a function that stops following.
 */
export function followCaptureFile(file: string, onText: (text: string) => void): () => void {
  let offset = 0;
  let decoder: StringDecoder | null = null;
  const interval = setInterval(() => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return;
      const chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      let bytes = chunk;
      if (!decoder) {
        if (offset === 0 && chunk.length < 2) return;
        const utf16 = offset === 0 && chunk[0] === 0xff && chunk[1] === 0xfe;
        decoder = new StringDecoder(utf16 ? "utf16le" : "utf8");
        if (utf16) bytes = chunk.subarray(2);
      }
      offset = size;
      const text = decoder.write(bytes);
      if (text) onText(text);
    } catch {
      // Not created yet, or already removed.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }, 500);
  return () => clearInterval(interval);
}
