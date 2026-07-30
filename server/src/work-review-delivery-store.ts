import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { socketAgentDataPath } from "./socket-agent-paths";

export interface WorkReviewResultDeliveryRecord {
  resultId: string;
  reviewId?: string;
  roundId?: string;
  originSessionId?: string;
  createdAt?: string;
  deliveredAt?: string;
}

interface DeliverySnapshot {
  schemaVersion: 1;
  records: WorkReviewResultDeliveryRecord[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Durable result outbox. A published review and its delivery state live in
 * separate atomic stores so startup recovery can reconstruct either side.
 */
export class WorkReviewResultDeliveryStore {
  private snapshot: DeliverySnapshot;

  constructor(
    private readonly filePath = socketAgentDataPath("work-reviews", "result-deliveries.json"),
  ) {
    this.snapshot = this.read();
  }

  enqueue(
    review: Record<string, unknown>,
    result: Record<string, unknown>,
  ): WorkReviewResultDeliveryRecord {
    const resultId = String(result.resultId || "");
    const originSessionId = String(review.originSessionId || "");
    if (!resultId || !originSessionId) {
      throw new Error("Work Review result delivery requires resultId and originSessionId");
    }
    const existing = this.snapshot.records.find((record) => record.resultId === resultId);
    if (existing) {
      if (existing.deliveredAt) return clone(existing);
      if (existing.originSessionId !== originSessionId) {
        throw new Error(`Work Review result ${resultId} has conflicting origin sessions`);
      }
      return clone(existing);
    }
    const record: WorkReviewResultDeliveryRecord = {
      resultId,
      reviewId: String(result.reviewId || review.reviewId || ""),
      roundId: String(result.roundId || ""),
      originSessionId,
      createdAt: new Date().toISOString(),
    };
    this.snapshot.records.push(record);
    this.write();
    return clone(record);
  }

  pending(): WorkReviewResultDeliveryRecord[] {
    return this.snapshot.records
      .filter((record) => !record.deliveredAt)
      .map(clone);
  }

  isDelivered(resultId: string): boolean {
    return this.snapshot.records.some(
      (record) => record.resultId === resultId && !!record.deliveredAt,
    );
  }

  markDelivered(resultId: string): void {
    const record = this.snapshot.records.find((candidate) => candidate.resultId === resultId);
    if (!record || record.deliveredAt) return;
    // Delivered entries become compact tombstones. Keeping resultId forever
    // prevents startup scans from resurrecting old published results without
    // retaining potentially multi-megabyte review payloads.
    const index = this.snapshot.records.indexOf(record);
    this.snapshot.records[index] = {
      resultId,
      deliveredAt: new Date().toISOString(),
    };
    this.write();
  }

  private read(): DeliverySnapshot {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as DeliverySnapshot;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.records)) {
        return {
          schemaVersion: 1,
          records: parsed.records.filter((record) =>
            !!record
            && typeof record.resultId === "string"
            && (
              typeof record.deliveredAt === "string"
              || (
                typeof record.reviewId === "string"
                && typeof record.roundId === "string"
                && typeof record.originSessionId === "string"
              )
            )),
        };
      }
    } catch {}
    return { schemaVersion: 1, records: [] };
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
    );
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.snapshot), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }
}
