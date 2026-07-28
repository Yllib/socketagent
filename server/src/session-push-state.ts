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
