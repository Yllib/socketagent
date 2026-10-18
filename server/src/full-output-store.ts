import * as fs from "fs";
import * as path from "path";
import { toolOutputSessionDir } from "./history-storage";
import { socketAgentDataPath } from "./socket-agent-paths";

// The full output of a command whose output the agent cut down (a `| tail`
// filter, or the backend truncating a long result). It sits beside the
// session's other tool output, so deleting or renaming a session takes it
// along. Kept whole for a day, then trimmed to TRIMMED_CHARS.

const TOOL_OUTPUT_DIR = socketAgentDataPath("tool-output");
const FULL_PREFIX = "full-";
const KEEP_WHOLE_MS = 24 * 60 * 60 * 1000;
const TRIMMED_HEAD_CHARS = 2 * 1024;
const TRIMMED_TAIL_CHARS = 8 * 1024;
// Guards against a runaway log; far beyond anything a phone can show.
const MAX_STORED_BYTES = 8 * 1024 * 1024;

function fullOutputFile(sessionId: string, toolUseId: string): string {
  const safeId = toolUseId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return path.join(toolOutputSessionDir(sessionId), `${FULL_PREFIX}${safeId}.txt`);
}

/** Capture files are UTF-8, except Windows PowerShell 5.1's Tee-Object, which writes UTF-16LE. */
export function decodeCapture(raw: Buffer): string {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le");
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString("utf8");
  return raw.toString("utf8");
}

function keepEnds(text: string, headChars: number, tailChars: number, reason: string): string {
  // The slack leaves room for the marker, so a trimmed file is never trimmed again.
  if (text.length <= headChars + tailChars + 256) return text;
  const dropped = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n[${Math.ceil(dropped / 1024)} KB ${reason}]\n\n${text.slice(-tailChars)}`;
}

function readCapture(capturePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(capturePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= MAX_STORED_BYTES) return decodeCapture(fs.readFileSync(fd));
    // Read the first and last parts only, so a huge log never sits in memory.
    const head = Buffer.alloc(MAX_STORED_BYTES / 8);
    const tail = Buffer.alloc(MAX_STORED_BYTES - head.length);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const utf16 = head[0] === 0xff && head[1] === 0xfe;
    const tailText = utf16 ? tail.subarray(tail.length % 2).toString("utf16le") : tail.toString("utf8");
    const dropped = Math.ceil((size - head.length - tail.length) / 1024);
    return `${decodeCapture(head)}\n\n[${dropped} KB not kept]\n\n${tailText}`;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copies a command's capture file into the session. Returns the stored size in
 * bytes, or null when the capture is missing or adds nothing beyond `shown`.
 */
export function saveFullOutput(sessionId: string, toolUseId: string, capturePath: string, shown: string): number | null {
  const text = readCapture(capturePath);
  // Nothing to add when the agent already saw all of it, for example inside
  // an error report that wraps the same text.
  if (!text?.trim() || shown.includes(text.trim())) return null;
  const file = fullOutputFile(sessionId, toolUseId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return Buffer.byteLength(text, "utf8");
}

export function readFullOutput(sessionId: string, toolUseId: string): string | null {
  try {
    return fs.readFileSync(fullOutputFile(sessionId, toolUseId), "utf8");
  } catch {
    return null;
  }
}

/** Trims full outputs older than a day to their first and last few KB. */
export async function trimOldFullOutputs(now = Date.now()): Promise<number> {
  const cutoff = now - KEEP_WHOLE_MS;
  let sessions: string[];
  try {
    sessions = await fs.promises.readdir(TOOL_OUTPUT_DIR);
  } catch {
    return 0;
  }
  let trimmed = 0;
  for (const session of sessions) {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.join(TOOL_OUTPUT_DIR, session));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(FULL_PREFIX)) continue;
      const file = path.join(TOOL_OUTPUT_DIR, session, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs > cutoff || stat.size <= TRIMMED_HEAD_CHARS + TRIMMED_TAIL_CHARS) continue;
        const text = await fs.promises.readFile(file, "utf8");
        const kept = keepEnds(text, TRIMMED_HEAD_CHARS, TRIMMED_TAIL_CHARS, "trimmed after a day");
        if (kept === text) continue;
        await fs.promises.writeFile(file, kept);
        trimmed++;
      } catch {
        // The session was deleted mid-sweep.
      }
    }
  }
  return trimmed;
}

/** Trims shortly after startup, then hourly. */
export function startFullOutputTrimming(): void {
  const run = () => {
    trimOldFullOutputs()
      .then((count) => { if (count > 0) console.log(`[FullOutput] Trimmed ${count} day-old outputs`); })
      .catch((err: unknown) => console.warn(`[FullOutput] Trim failed: ${String(err)}`));
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}
