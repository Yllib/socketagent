/**
 * Sends the first cumulative stream snapshot immediately, then keeps only the
 * newest snapshot during each short cadence window. Final snapshots bypass
 * this helper and discard any older pending revision.
 */
export class LatestSnapshotDispatcher<T> {
  private states = new Map<string, {
    lastSentAt: number;
    pending?: T;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly dispatch: (message: T) => void,
    private readonly intervalMs = 40,
  ) {}

  push(key: string, message: T): void {
    const now = Date.now();
    let state = this.states.get(key);
    if (!state) {
      state = { lastSentAt: now };
      this.states.set(key, state);
      this.dispatch(message);
      return;
    }

    const elapsed = now - state.lastSentAt;
    if (elapsed >= this.intervalMs && !state.timer) {
      state.lastSentAt = now;
      this.dispatch(message);
      return;
    }

    state.pending = message;
    if (state.timer) return;
    state.timer = setTimeout(() => this.flush(key), Math.max(1, this.intervalMs - elapsed));
    state.timer.unref?.();
  }

  flush(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const pending = state.pending;
    state.pending = undefined;
    if (pending === undefined) return;
    state.lastSentAt = Date.now();
    this.dispatch(pending);
  }

  flushAll(): void {
    for (const key of [...this.states.keys()]) this.flush(key);
  }

  discard(key: string): void {
    const state = this.states.get(key);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(key);
  }

  dispose(flush = false): void {
    if (flush) this.flushAll();
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.states.clear();
  }
}
