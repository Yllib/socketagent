import * as fs from "fs";
import * as path from "path";
import { socketAgentDataPath } from "./socket-agent-paths";

export interface SessionAutomationLock {
  sessionId: string;
  stoppedAt: string;
}

interface SessionAutomationLockFile {
  version: 1;
  locks: SessionAutomationLock[];
}

/**
 * Durable safety latch set by the Stop button.
 *
 * The latch is intentionally independent from session/runtime metadata. It is
 * written before process termination begins and survives a server restart.
 * Only an explicit user prompt is allowed to remove it.
 */
export class SessionAutomationLockStore {
  private readonly locks = new Map<string, SessionAutomationLock>();

  constructor(
    private readonly filePath = socketAgentDataPath("session-automation-locks.json"),
  ) {
    this.load();
  }

  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId.trim());
  }

  lock(sessionId: string, stoppedAt = new Date().toISOString()): SessionAutomationLock {
    const id = sessionId.trim();
    if (!id) throw new Error("Cannot lock an empty session ID");
    const existing = this.locks.get(id);
    if (existing) {
      // A prior persistence attempt may have failed after the in-memory latch
      // was installed. Retransmitted Stop requests must retry the durable write.
      this.persist();
      return existing;
    }
    const record = { sessionId: id, stoppedAt };
    this.locks.set(id, record);
    this.persist();
    return record;
  }

  unlockForUserPrompt(sessionId: string): boolean {
    const id = sessionId.trim();
    if (!id || !this.locks.delete(id)) return false;
    this.persist();
    return true;
  }

  list(): SessionAutomationLock[] {
    return [...this.locks.values()];
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SessionAutomationLockFile;
      for (const record of Array.isArray(parsed?.locks) ? parsed.locks : []) {
        const sessionId = String(record?.sessionId || "").trim();
        const stoppedAt = String(record?.stoppedAt || "").trim();
        if (sessionId && stoppedAt) this.locks.set(sessionId, { sessionId, stoppedAt });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn(`[StopLock] Failed to load ${this.filePath}: ${error?.message || error}`);
      }
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const contents: SessionAutomationLockFile = {
      version: 1,
      locks: this.list(),
    };
    fs.writeFileSync(temporaryPath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

export class SessionAutomationLockedError extends Error {
  readonly code = "SESSION_STOPPED_BY_USER";

  constructor(readonly sessionId: string, readonly source: string) {
    super(`Session ${sessionId} is stopped; ${source} is deferred until the user sends a message`);
    this.name = "SessionAutomationLockedError";
  }
}
