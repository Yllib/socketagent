import * as crypto from "crypto";
import * as fs from "fs";
import * as readline from "readline";
import * as zlib from "zlib";
import { once } from "events";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { parentPort, workerData, type MessagePort } from "worker_threads";
import { z } from "zod";
import { parseHistoryEntry } from "./history-schema";
import {
  compactHistoryEntryForStorage,
  hydrateHistoryEntry,
  toolOutputSessionDir,
} from "./history-storage";
import type { HistoryEntry } from "./protocol";
import { redactSecretsDeep } from "./secure-input-store";
import {
  HANDOFF_TAIL_ENTRIES,
  type BundleHeader,
  type BundleRecord,
  bundleHeaderSchema,
  bundleRecords,
  buildSessionHandoffContext,
  exportedEntry,
  fileSha256,
  invalidBundle,
  parseBundleBody,
  parseBundleHeader,
} from "./session-transfer-bundle";
import { MAX_TRANSFER_BUNDLE_BYTES } from "./session-transfer-jobs";
import { TranscriptDatabase } from "./transcript-database";

/**
 * Runs one session transfer step off the main thread: sizing, writing, or
 * restoring a bundle, so a huge session never blocks the server's event loop.
 * Sizing and export read through the worker's own database connection. Import
 * does the checksum, parsing, and tool-output blobs here but hands prepared
 * entries back in batches for the main thread to insert. SQLite's write lock
 * is not fair, so a second writer here could starve the server's own history
 * writes for seconds. The worker never touches session metadata.
 *
 * Messages to the main thread are { kind: "batch", entries }, which it answers
 * once written, and a final { kind: "result", result }.
 */

/** Entries per page when reading a transcript. */
const READ_BATCH_ENTRIES = 1000;
/**
 * Limits on each batch the main thread inserts in one go, so each insert takes
 * tens of milliseconds. Tool calls can carry multi-megabyte inputs, so a byte
 * limit matters as much as the count.
 */
const WRITE_BATCH_ENTRIES = 200;
const WRITE_BATCH_BYTES = 1024 * 1024;

const transferWorkerTaskSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("estimate"), sessionId: z.string().min(1) }),
  z.object({
    op: z.literal("export"),
    sessionId: z.string().min(1),
    /** Where to write the bundle. The main thread renames it once it is complete. */
    bundlePath: z.string().min(1),
    /** Everything but the handoff context, which the worker builds from the transcript tail. */
    header: bundleHeaderSchema,
    sdkEvents: z.array(z.record(z.string(), z.unknown())),
    nativePath: z.string().optional(),
  }),
  z.object({
    op: z.literal("import"),
    bundlePath: z.string().min(1),
    expectedSha256: z.string(),
    sessionId: z.string().min(1),
    /** Claude JSONL destination for an exact move. */
    nativePath: z.string().optional(),
  }),
]);

/** What the main thread sends. The worker validates it against the schema above. */
export type TransferWorkerTask =
  | { op: "estimate"; sessionId: string }
  | {
    op: "export";
    sessionId: string;
    bundlePath: string;
    header: BundleHeader;
    sdkEvents: Record<string, unknown>[];
    nativePath?: string;
  }
  | { op: "import"; bundlePath: string; expectedSha256: string; sessionId: string; nativePath?: string };
type Task<Op extends TransferWorkerTask["op"]> = Extract<z.infer<typeof transferWorkerTaskSchema>, { op: Op }>;

function estimate(task: Task<"estimate">) {
  const db = new TranscriptDatabase();
  try {
    return db.transferSize(task.sessionId);
  } finally {
    db.close();
  }
}

async function exportBundle(task: Task<"export">) {
  const db = new TranscriptDatabase();
  const digest = crypto.createHash("sha256");
  let fileSize = 0;
  const gzip = zlib.createGzip({ level: 6 });
  const written = pipeline(
    gzip,
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        digest.update(chunk);
        fileSize += chunk.length;
        if (fileSize > MAX_TRANSFER_BUNDLE_BYTES) {
          done(new Error("Compressed session bundle exceeds the transfer limit"));
          return;
        }
        done(null, chunk);
      },
    }),
    fs.createWriteStream(task.bundlePath, { mode: 0o600 }),
  );
  const write = async (record: BundleRecord): Promise<void> => {
    if (!gzip.write(`${JSON.stringify(record)}\n`)) await once(gzip, "drain");
  };
  try {
    const tail = db.getTail(task.sessionId, HANDOFF_TAIL_ENTRIES).map(hydrateHistoryEntry);
    const header: BundleHeader = {
      ...task.header,
      handoffContext: buildSessionHandoffContext(task.header.session, tail, task.header.todos),
    };
    await write(header);
    // Page by sequence so only one page of entries is ever in memory.
    let history = 0;
    let after = 0;
    for (;;) {
      const page = db.getAfter(task.sessionId, after, READ_BATCH_ENTRIES);
      if (page.length === 0) break;
      for (const entry of page) await write({ kind: "history", entry: exportedEntry(entry, task.header.transcript) });
      history += page.length;
      after = page[page.length - 1].sessionSeq ?? after;
    }
    for (const event of task.sdkEvents) await write({ kind: "sdkEvent", event });
    let native = 0;
    if (task.nativePath) {
      const lines = readline.createInterface({ input: fs.createReadStream(task.nativePath), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        await write({ kind: "native", line });
        native++;
      }
    }
    await write({ kind: "end", history, sdkEvents: task.sdkEvents.length, native });
    gzip.end();
    await written;
    const fd = fs.openSync(task.bundlePath, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    gzip.destroy();
    await written.catch(() => {});
    fs.rmSync(task.bundlePath, { force: true });
    throw error;
  } finally {
    db.close();
  }
  return { fileSize, sha256: digest.digest("hex") };
}

/** Same storage preparation replaceHistory applies, minus the main thread's position bookkeeping. */
function storedEntry(sessionId: string, entry: HistoryEntry, index: number): HistoryEntry {
  const stored = compactHistoryEntryForStorage(sessionId, parseHistoryEntry(redactSecretsDeep(entry)), index);
  // Every stored entry has a durable position, so a bundle entry without one is malformed.
  if (!stored.entryId || !Number.isSafeInteger(stored.sessionSeq) || stored.sessionSeq! <= 0) {
    throw invalidBundle("history.sessionSeq");
  }
  return stored;
}

/** Hands one prepared batch to the main thread and waits until it is written. */
function writeOnMainThread(port: MessagePort, entries: HistoryEntry[]): Promise<void> {
  return new Promise((resolve) => {
    port.once("message", () => resolve());
    port.postMessage({ kind: "batch", entries });
  });
}

async function importBundle(task: Task<"import">, port: MessagePort) {
  if (!/^[a-f0-9]{64}$/i.test(task.expectedSha256)
      || await fileSha256(task.bundlePath) !== task.expectedSha256.toLowerCase()) {
    throw new Error("Session transfer checksum mismatch");
  }
  let nativeFd: number | undefined;
  const nativeTemporary = task.nativePath ? `${task.nativePath}.${process.pid}.tmp` : undefined;
  try {
    // Clear blobs a crashed earlier attempt left for this session.
    fs.rmSync(toolOutputSessionDir(task.sessionId), { recursive: true, force: true });
    if (nativeTemporary) nativeFd = fs.openSync(nativeTemporary, "w", 0o600);

    const records = bundleRecords(task.bundlePath);
    const first = await records.next();
    parseBundleHeader(first.done ? undefined : first.value);
    let batch: HistoryEntry[] = [];
    let batchBytes = 0;
    let history = 0;
    let native = 0;
    const sdkEvents: Record<string, unknown>[] = [];
    let end: { history: number; sdkEvents: number; native: number } | undefined;
    for await (const value of records) {
      if (end) throw invalidBundle("end");
      const record = parseBundleBody(value);
      if (record.kind === "history") {
        const entry = storedEntry(task.sessionId, record.entry, history++);
        const bytes = JSON.stringify(entry).length;
        if (batch.length > 0 && (batch.length >= WRITE_BATCH_ENTRIES || batchBytes + bytes > WRITE_BATCH_BYTES)) {
          await writeOnMainThread(port, batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(entry);
        batchBytes += bytes;
      } else if (record.kind === "sdkEvent") {
        sdkEvents.push(record.event);
      } else if (record.kind === "native") {
        if (nativeFd !== undefined) {
          JSON.parse(record.line);
          fs.writeSync(nativeFd, `${record.line}\n`);
        }
        native++;
      } else {
        end = record;
      }
    }
    if (batch.length > 0) await writeOnMainThread(port, batch);
    if (!end || end.history !== history || end.sdkEvents !== sdkEvents.length || end.native !== native) {
      throw invalidBundle("end");
    }
    if (task.nativePath && nativeTemporary && nativeFd !== undefined) {
      if (native === 0) throw new Error("Claude transcript is empty");
      fs.fsyncSync(nativeFd);
      fs.closeSync(nativeFd);
      nativeFd = undefined;
      fs.renameSync(nativeTemporary, task.nativePath);
    }
    return { sdkEvents };
  } catch (error) {
    if (nativeFd !== undefined) {
      try { fs.closeSync(nativeFd); } catch {}
    }
    if (nativeTemporary) fs.rmSync(nativeTemporary, { force: true });
    throw error;
  }
}

async function run(data: unknown, port: MessagePort) {
  const task = transferWorkerTaskSchema.parse(data);
  if (task.op === "estimate") return estimate(task);
  if (task.op === "export") return exportBundle(task);
  return importBundle(task, port);
}

if (parentPort) {
  const port = parentPort;
  const data: unknown = workerData;
  // A rejection becomes the worker's "error" event on the main thread.
  void run(data, port).then((result) => port.postMessage({ kind: "result", result }));
}
