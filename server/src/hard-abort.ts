export interface AbortableSession {
  abort(): void | Promise<void>;
}

export interface HardAbortResult {
  stopped: true;
  alreadyStopped: boolean;
}

type AbortLookup = () => AbortableSession | null | undefined;
type AbortRemove = (target: AbortableSession) => void;

/**
 * Makes hard-abort requests idempotent. Retransmitted requests join the same
 * operation and receive the same completion result; failures are not cached,
 * so a later retry gets another chance to terminate the backend.
 */
export class HardAbortCoordinator {
  private readonly inFlight = new Map<string, Promise<HardAbortResult>>();
  private readonly completed = new Map<string, HardAbortResult>();

  constructor(private readonly retentionMs = 5 * 60_000) {}

  abort(
    requestId: string,
    sessionId: string,
    lookup: AbortLookup,
    remove: AbortRemove,
  ): Promise<HardAbortResult> {
    const key = `${sessionId}\u0001${requestId}`;
    const completed = this.completed.get(key);
    if (completed) return Promise.resolve(completed);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = (async (): Promise<HardAbortResult> => {
      const target = lookup();
      if (!target) {
        return { stopped: true, alreadyStopped: true };
      }
      await target.abort();
      remove(target);
      return { stopped: true, alreadyStopped: false };
    })();

    this.inFlight.set(key, operation);
    void operation
      .then((result) => {
        this.completed.set(key, result);
        const timer = setTimeout(() => this.completed.delete(key), this.retentionMs);
        timer.unref?.();
      })
      .catch(() => {
        // The caller receives the failure; this observer only manages cache.
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    return operation;
  }
}
