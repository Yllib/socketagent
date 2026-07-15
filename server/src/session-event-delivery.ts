import { randomUUID } from "crypto";

type SessionEvent = Record<string, any>;

interface PendingDelivery {
  message: SessionEvent;
  attempts: number;
  createdAt: number;
}

const ACKED_EVENT_TYPES = new Set([
  "tool_call",
  "tool_result",
]);

/**
 * Retains card-defining session events until the app confirms that its live
 * reducer applied them. WebSocket delivery alone is not sufficient: a frame
 * can reach the phone while a session/provider transition discards it.
 */
export class SessionEventDelivery {
  private pending = new Map<string, PendingDelivery>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dispatch: (message: SessionEvent) => void,
    private readonly retryMs = 750,
    private readonly maxPending = 1_000,
    private readonly maxAgeMs = 10 * 60_000,
  ) {}

  prepare(message: SessionEvent): SessionEvent {
    if (!ACKED_EVENT_TYPES.has(String(message.type || ""))) return message;
    if (typeof message.deliveryId === "string" && message.deliveryId) {
      return message;
    }

    const deliveryId = randomUUID();
    const tracked = { ...message, deliveryId };
    this.pending.set(deliveryId, {
      message: tracked,
      attempts: 0,
      createdAt: Date.now(),
    });
    this.trim();
    this.scheduleRetry();
    return tracked;
  }

  acknowledge(deliveryId: string): boolean {
    const removed = this.pending.delete(deliveryId);
    if (this.pending.size === 0 && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return removed;
  }

  replayTo(dispatch: (message: SessionEvent) => void): void {
    for (const entry of this.pending.values()) {
      dispatch({ ...entry.message, replay: true });
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pending.clear();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.pending.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryPending();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private retryPending(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [deliveryId, entry] of this.pending.entries()) {
      if (entry.createdAt < cutoff) {
        this.pending.delete(deliveryId);
        continue;
      }
      entry.attempts++;
      this.dispatch({
        ...entry.message,
        replay: true,
        deliveryAttempt: entry.attempts + 1,
      });
    }
    this.scheduleRetry();
  }

  private trim(): void {
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
  }
}
