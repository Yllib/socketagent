export type SessionPushEventKind = "session_started" | "session_finished";

export interface SessionPushRun {
  sessionId: string;
  startedAt: string;
  runKey: string;
  startedClaimed: boolean;
  completionClaimed: boolean;
}

export function sessionPushRunKey(sessionId: string, startedAt: string): string {
  return `${sessionId}\u0001${startedAt}`;
}

export function sessionPushEventId(
  kind: SessionPushEventKind,
  sessionId: string,
  startedAt: string,
): string {
  return `${kind}:${sessionId}:${startedAt}`;
}

export function completionTranscriptTarget(
  entries: Array<{
    role?: unknown;
    entryId?: unknown;
    sessionSeq?: unknown;
    timestamp?: unknown;
  }>,
  notBefore?: string,
): { targetEntryId?: string; targetSessionSeq?: number } {
  const notBeforeMs = notBefore ? Date.parse(notBefore) : Number.NaN;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.role !== "assistant") continue;
    if (Number.isFinite(notBeforeMs)) {
      const timestampMs = typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp)
        : Number.NaN;
      if (!Number.isFinite(timestampMs) || timestampMs < notBeforeMs) continue;
    }
    const entryId = typeof entry.entryId === "string"
      ? entry.entryId.trim()
      : "";
    const rawSessionSeq = Number(entry.sessionSeq);
    const sessionSeq = Number.isSafeInteger(rawSessionSeq) && rawSessionSeq > 0
      ? rawSessionSeq
      : undefined;
    if (!entryId && sessionSeq === undefined) continue;
    return {
      ...(entryId ? { targetEntryId: entryId } : {}),
      ...(sessionSeq !== undefined ? { targetSessionSeq: sessionSeq } : {}),
    };
  }
  return {};
}

/**
 * Tracks one notification lifecycle per SDK run. Session objects are reused
 * across turns, so a new activeStartedAt replaces the object's prior run.
 */
export class SessionPushRunTracker<T extends object> {
  private readonly runs = new WeakMap<T, SessionPushRun>();
  private readonly completedRunKeys = new Map<string, number>();

  begin(session: T, sessionId: string, startedAt: string): SessionPushRun {
    const runKey = sessionPushRunKey(sessionId, startedAt);
    const existing = this.runs.get(session);
    if (existing?.runKey === runKey) return existing;
    const run: SessionPushRun = {
      sessionId,
      startedAt,
      runKey,
      startedClaimed: false,
      completionClaimed: false,
    };
    this.runs.set(session, run);
    return run;
  }

  claimStarted(
    session: T,
    sessionId: string,
    startedAt: string,
  ): SessionPushRun | null {
    const run = this.begin(session, sessionId, startedAt);
    if (run.startedClaimed) return null;
    run.startedClaimed = true;
    return run;
  }

  claimCompletion(
    session: T,
    sessionId: string,
    fallbackStartedAt: string,
  ): SessionPushRun | null {
    let run = this.runs.get(session);
    if (!run || run.sessionId !== sessionId) {
      run = this.begin(session, sessionId, fallbackStartedAt);
    }
    if (run.completionClaimed || this.completedRunKeys.has(run.runKey)) {
      return null;
    }
    run.completionClaimed = true;
    this.completedRunKeys.set(run.runKey, Date.now());
    this.pruneCompletedRuns();
    return run;
  }

  private pruneCompletedRuns(): void {
    if (this.completedRunKeys.size <= 1000) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [runKey, completedAt] of this.completedRunKeys) {
      if (completedAt < cutoff || this.completedRunKeys.size > 800) {
        this.completedRunKeys.delete(runKey);
      }
    }
  }
}
