import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { socketAgentDataPath } from "./socket-agent-paths";
import {
  StoredWorkReviewRecord,
  WORK_REVIEW_SCHEMA_VERSION,
  WorkReviewError,
} from "./work-review-types";

interface WorkReviewIndexEntry {
  reviewId: string;
  originSessionId: string;
  updatedAt: string;
  archivedAt?: string;
  idempotency: Array<{ keyHash: string; contentHash: string; revision: number }>;
}

interface WorkReviewIndex {
  schemaVersion: 1;
  rebuiltAt: string;
  entries: WorkReviewIndexEntry[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validRecord(value: unknown): value is StoredWorkReviewRecord {
  const record = value as StoredWorkReviewRecord;
  return !!record
    && record.schemaVersion === WORK_REVIEW_SCHEMA_VERSION
    && typeof record.reviewId === "string"
    && typeof record.cardId === "string"
    && typeof record.originSessionId === "string"
    && Number.isInteger(record.currentRevision)
    && Array.isArray(record.rounds)
    && Array.isArray(record.events)
    && record.rounds.length > 0
    && record.rounds.every((round, index) =>
      !!round
      && typeof round.roundId === "string"
      && round.revision === index
      && typeof round.idempotencyKeyHash === "string"
      && typeof round.contentHash === "string"
      && Array.isArray(round.items)
      && (round.status === "in_review"
        || round.status === "completed"
        || round.status === "cancelled"),
    )
    && record.currentRevision === record.rounds.length - 1;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const directoryFd = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  }
}

/**
 * Atomic, portable file store. Each review is its own replacement-written file;
 * index.json is derived data and is rebuilt from records whenever it is absent
 * or damaged.
 */
export class WorkReviewStore {
  private readonly recordsDir: string;
  private readonly indexFile: string;
  private index: WorkReviewIndex;

  constructor(public readonly rootDir: string = socketAgentDataPath("work-reviews")) {
    this.recordsDir = path.join(rootDir, "records");
    this.indexFile = path.join(rootDir, "index.json");
    fs.mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    this.removeStaleTemporaryFiles();
    // The index is derived. Rebuilding at startup also recovers a record that
    // was renamed into place immediately before a crash interrupted index write.
    this.index = this.rebuildIndex();
  }

  private recordFile(reviewId: string): string {
    const name = crypto.createHash("sha256").update(reviewId).digest("hex");
    return path.join(this.recordsDir, `${name}.json`);
  }

  private removeStaleTemporaryFiles(): void {
    for (const directory of [this.rootDir, this.recordsDir]) {
      let names: string[] = [];
      try { names = fs.readdirSync(directory); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".tmp")) continue;
        try {
          const temporary = path.join(directory, name);
          // Other SocketAgent/test processes may be writing the same portable
          // store. Only reap unmistakably abandoned temporaries.
          if (Date.now() - fs.statSync(temporary).mtimeMs > 60 * 60 * 1000) {
            fs.unlinkSync(temporary);
          }
        } catch {}
      }
    }
  }

  private readIndex(): WorkReviewIndex | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as WorkReviewIndex;
      if (
        parsed?.schemaVersion !== 1
        || !Array.isArray(parsed.entries)
        || parsed.entries.some((entry) =>
          !entry
          || typeof entry.reviewId !== "string"
          || !Array.isArray(entry.idempotency),
        )
      ) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  rebuildIndex(): WorkReviewIndex {
    const entries: WorkReviewIndexEntry[] = [];
    let files: string[] = [];
    try { files = fs.readdirSync(this.recordsDir); } catch {}
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.recordsDir, name);
      let recovered: StoredWorkReviewRecord | undefined;
      for (const candidate of [file, `${file}.bak`]) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
          if (!validRecord(parsed)) continue;
          recovered = parsed;
          if (candidate.endsWith(".bak")) atomicWriteJson(file, parsed);
          break;
        } catch {}
      }
      if (recovered) entries.push(this.toIndexEntry(recovered));
      // A record damaged along with its backup is isolated; recovery continues.
    }
    this.index = {
      schemaVersion: 1,
      rebuiltAt: new Date().toISOString(),
      entries: entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
    atomicWriteJson(this.indexFile, this.index);
    return clone(this.index);
  }

  private toIndexEntry(record: StoredWorkReviewRecord): WorkReviewIndexEntry {
    return {
      reviewId: record.reviewId,
      originSessionId: record.originSessionId,
      updatedAt: record.updatedAt,
      ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
      idempotency: record.rounds.map((round) => ({
        keyHash: round.idempotencyKeyHash,
        contentHash: round.contentHash,
        revision: round.revision,
      })),
    };
  }

  private writeIndex(): void {
    this.index.rebuiltAt = new Date().toISOString();
    this.index.entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    atomicWriteJson(this.indexFile, this.index);
  }

  findIdempotency(
    originSessionId: string,
    keyHash: string,
  ): { reviewId: string; contentHash: string; revision: number } | undefined {
    for (const entry of this.index.entries) {
      if (entry.originSessionId !== originSessionId) continue;
      const match = entry.idempotency.find((candidate) => candidate.keyHash === keyHash);
      if (match) return { reviewId: entry.reviewId, ...match };
    }
    return undefined;
  }

  get(reviewId: string): StoredWorkReviewRecord | undefined {
    const file = this.recordFile(reviewId);
    for (const candidate of [file, `${file}.bak`]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (!validRecord(parsed) || parsed.reviewId !== reviewId) continue;
        if (candidate.endsWith(".bak")) {
          // Restore the last valid authoritative snapshot for future reads.
          atomicWriteJson(file, parsed);
        }
        return clone(parsed);
      } catch {}
    }
    return undefined;
  }

  list(): StoredWorkReviewRecord[] {
    const records: StoredWorkReviewRecord[] = [];
    let needsRepair = false;
    for (const entry of this.index.entries) {
      const record = this.get(entry.reviewId);
      if (record) records.push(record);
      else needsRepair = true;
    }
    if (needsRepair) this.rebuildIndex();
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  save(record: StoredWorkReviewRecord): StoredWorkReviewRecord {
    if (!validRecord(record)) {
      throw new WorkReviewError("validation", "Refusing to persist an invalid work review");
    }
    const file = this.recordFile(record.reviewId);
    try {
      const current = JSON.parse(fs.readFileSync(file, "utf8"));
      if (validRecord(current) && current.reviewId === record.reviewId) {
        atomicWriteJson(`${file}.bak`, current);
      }
    } catch {}
    atomicWriteJson(file, record);
    const entry = this.toIndexEntry(record);
    const index = this.index.entries.findIndex((candidate) => candidate.reviewId === record.reviewId);
    if (index >= 0) this.index.entries[index] = entry;
    else this.index.entries.push(entry);
    try {
      this.writeIndex();
    } catch (error: any) {
      // The per-review record is authoritative and already durable. Do not
      // report a failed Finish/Create after it actually committed merely
      // because the rebuildable index could not be refreshed.
      console.warn(`[WorkReview] Failed to refresh derived index: ${error?.message || String(error)}`);
    }
    return clone(record);
  }
}
