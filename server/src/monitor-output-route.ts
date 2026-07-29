export interface MonitorOutputSession {
  readonly isRunning: boolean;
  getSessionId(): string | null;
  injectMessage(text: string, priority?: "next"): Promise<unknown>;
  runQuery(text: string, resumeSessionId?: string): Promise<unknown>;
}

export interface MonitorOutputRouteHooks {
  beforeIdleRun?(sessionId: string | undefined): void;
  afterIdleRun?(session: MonitorOutputSession): void;
  onError?(error: unknown): void;
}

/**
 * Delivers Monitor output only to the session that owned the Monitor tool
 * context. Callers must pass that stable object—not a mutable connection-wide
 * "active session" reference that can change while the monitor is waiting.
 */
export async function routeMonitorOutputToSession(
  owner: MonitorOutputSession,
  text: string,
  hooks: MonitorOutputRouteHooks = {},
): Promise<void> {
  try {
    if (owner.isRunning) {
      await owner.injectMessage(text, "next");
      return;
    }

    const sessionId = owner.getSessionId() || undefined;
    hooks.beforeIdleRun?.(sessionId);
    await owner.runQuery(text, sessionId);
    hooks.afterIdleRun?.(owner);
  } catch (error) {
    hooks.onError?.(error);
  }
}
