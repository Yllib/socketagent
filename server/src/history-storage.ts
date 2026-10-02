import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import type { HistoryEntry } from "./protocol";
import { socketAgentDataPath } from "./socket-agent-paths";
import { errorMessage } from "./value-guards";

/**
 * How history entries sit on disk: large tool outputs move to gzipped blobs
 * under tool-output/<session>, and position keys identify an entry's logical
 * slot. Kept apart from session-store so the transfer worker can use it
 * without loading the main thread's caches.
 */

const TOOL_OUTPUT_DIR = socketAgentDataPath("tool-output");
const TOOL_OUTPUT_BLOB_THRESHOLD = Number(process.env.SOCKETAGENT_TOOL_OUTPUT_BLOB_THRESHOLD || 8 * 1024);
const TOOL_OUTPUT_PREVIEW_CHARS = Number(process.env.SOCKETAGENT_TOOL_OUTPUT_PREVIEW_CHARS || 1024);

export function toolOutputSessionDir(sessionId: string): string {
  const root = path.resolve(TOOL_OUTPUT_DIR);
  const resolved = path.resolve(TOOL_OUTPUT_DIR, sessionId);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid tool output session id: ${sessionId}`);
  }
  return resolved;
}

function ensureToolOutputDir(sessionId?: string): string {
  const dir = sessionId ? toolOutputSessionDir(sessionId) : TOOL_OUTPUT_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeBlobSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.slice(0, 80) || "entry";
}

function toolOutputBlobRef(sessionId: string, entry: HistoryEntry, index: number, output: string): string {
  const idPart = sanitizeBlobSegment(entry.toolUseId || `${entry.role}-${index}`);
  const hash = crypto
    .createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(entry.toolUseId || "")
    .update("\0")
    .update(entry.timestamp || "")
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(output)
    .digest("hex")
    .slice(0, 16);
  return `${sessionId}/${idPart}-${hash}.txt.gz`;
}

function toolOutputBlobPath(ref: string | undefined): string | null {
  if (!ref) return null;
  const root = path.resolve(TOOL_OUTPUT_DIR);
  const resolved = path.resolve(TOOL_OUTPUT_DIR, ref);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function writeToolOutputBlob(sessionId: string, entry: HistoryEntry, index: number, output: string): {
  ref: string;
  bytes: number;
  storedBytes: number;
} {
  const ref = toolOutputBlobRef(sessionId, entry, index, output);
  const file = toolOutputBlobPath(ref);
  if (!file) throw new Error(`Invalid tool output blob ref for ${sessionId}`);
  ensureToolOutputDir(sessionId);
  if (!fs.existsSync(file)) {
    const compressed = zlib.gzipSync(Buffer.from(output, "utf8"));
    fs.writeFileSync(file, compressed);
  }
  const stat = fs.statSync(file);
  return {
    ref,
    bytes: Buffer.byteLength(output, "utf8"),
    storedBytes: stat.size,
  };
}

function readToolOutputBlob(entry: HistoryEntry): string | undefined {
  const file = toolOutputBlobPath(entry.toolOutputRef);
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const raw = fs.readFileSync(file);
    return entry.toolOutputEncoding === "gzip"
      ? zlib.gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
  } catch (err: unknown) {
    console.warn(`[HistoryBlob] Failed to read ${entry.toolOutputRef}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return { ...entry, toolInput: entry.toolInput ? { ...entry.toolInput } : entry.toolInput };
}

export function compactHistoryEntryForStorage(sessionId: string, entry: HistoryEntry, index: number): HistoryEntry {
  const compacted = cloneHistoryEntry(entry);
  if (compacted.role !== "tool_result") return compacted;
  if (compacted.toolOutputRef && typeof compacted.toolOutput !== "string") {
    const preview = (compacted.toolOutputPreview || compacted.content || "").slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
    compacted.content = preview;
    compacted.toolOutputPreview = preview;
    return compacted;
  }

  const output = typeof compacted.toolOutput === "string"
    ? compacted.toolOutput
    : typeof compacted.content === "string"
      ? compacted.content
      : "";

  if (!output) {
    delete compacted.toolOutputRef;
    delete compacted.toolOutputBytes;
    delete compacted.toolOutputStoredBytes;
    delete compacted.toolOutputPreview;
    delete compacted.toolOutputEncoding;
    return compacted;
  }

  if (Buffer.byteLength(output, "utf8") <= TOOL_OUTPUT_BLOB_THRESHOLD) {
    compacted.toolOutput = output;
    compacted.content = typeof compacted.content === "string" ? compacted.content : output;
    delete compacted.toolOutputRef;
    delete compacted.toolOutputBytes;
    delete compacted.toolOutputStoredBytes;
    delete compacted.toolOutputPreview;
    delete compacted.toolOutputEncoding;
    return compacted;
  }

  const blob = writeToolOutputBlob(sessionId, compacted, index, output);
  compacted.content = output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
  compacted.toolOutputPreview = compacted.content;
  compacted.toolOutputRef = blob.ref;
  compacted.toolOutputBytes = blob.bytes;
  compacted.toolOutputStoredBytes = blob.storedBytes;
  compacted.toolOutputEncoding = "gzip";
  delete compacted.toolOutput;
  return compacted;
}

/** Returns a copy with any large tool output read back from its on-disk blob. */
export function hydrateHistoryEntry(entry: HistoryEntry): HistoryEntry {
  const hydrated = cloneHistoryEntry(entry);
  if (entry.inlineImageContent) hydrated.content = entry.inlineImageContent;
  if (entry.role === "tool_result" && typeof entry.toolOutput !== "string" && entry.toolOutputRef) {
    hydrated.toolOutput = readToolOutputBlob(entry) ?? entry.toolOutputPreview ?? entry.content ?? "";
  }
  return hydrated;
}

export function historyPositionKey(entry: HistoryEntry): string | null {
  if (entry.streamId) {
    const streamRole = entry.thinking ? `${entry.role}_thinking` : entry.role;
    return `${streamRole}:stream:${entry.streamId}`;
  }
  if (entry.toolUseId && (entry.role === "tool_call" || entry.role === "tool_result" || entry.role === "tool_image")) {
    return `${entry.role}:tool:${entry.toolUseId}`;
  }
  if (entry.questionId) return `${entry.role}:question:${entry.questionId}`;
  if (entry.role === "user" && entry.uuid) return `user:uuid:${entry.uuid}`;
  if (entry.role === "monitor" && entry.taskId) return `monitor:${entry.taskId}`;
  if (entry.role === "task_state" && entry.taskId) {
    return `task_state:${entry.taskKind || "background"}:${entry.taskId}`;
  }
  if (entry.role === "work_review" && entry.reviewId) {
    return `work_review:${entry.reviewId}`;
  }
  return null;
}
