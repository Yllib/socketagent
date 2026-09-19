/**
 * Helpers behind the two-stage session list broadcast: a synchronous list
 * assembled from the store plus the last native scan, followed by a fresh
 * native scan that replaces it. Both stages have to agree about archived
 * sessions, or an archive visibly bounces back into the list.
 */

export interface MergeableSession {
  id: string;
  createdAt: string;
  lastActive: string;
  title: string;
  messagePreview: string;
}

/**
 * The single rule for a session's timestamps when a stored record and a native
 * transcript describe the same session.
 *
 * Every merge site has to use it. The app sorts on lastActive and is handed
 * each of these lists in turn, seconds apart, so a site that decides
 * differently makes its rows jump between two positions on every broadcast.
 *
 * lastActive takes the newest evidence from either side. createdAt prefers the
 * stored record, which predates any rewriting of the native transcript.
 */
export function mergeSessionTimestamps(
  stored: { createdAt?: string; lastActive?: string },
  native: { createdAt: string; lastActive: string },
): { createdAt: string; lastActive: string } {
  return {
    createdAt: stored.createdAt || native.createdAt,
    lastActive: newestIso([stored.lastActive, native.lastActive], native.lastActive),
  };
}

/** Latest of the given timestamps, or `fallback` when none are usable. */
export function newestIso(values: Array<string | undefined>, fallback: string): string {
  let best = fallback;
  let bestMs = Date.parse(fallback);
  if (!Number.isFinite(bestMs)) bestMs = 0;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * Builds the session list served immediately, before any native scan runs.
 *
 * `nativeSnapshot` is the result of the last completed scan, so it still holds
 * sessions archived since. The store no longer lists them, but the merge would
 * put them back, so archived ids are dropped from both sides. Stored fields win
 * over native ones except where the store has nothing worth showing.
 *
 * Timestamps follow the same rules the native scan applies in
 * sdkSessionInfoToSessionInfo. They have to: the app sorts on lastActive, and
 * the two lists alternate every couple of seconds, so any disagreement makes
 * half the rows change their sort key on every broadcast and the list reshuffle
 * under the user's finger.
 */
export function mergeSessionListBase<T extends MergeableSession>(
  stored: readonly T[],
  nativeSnapshot: readonly T[] | null,
  archivedIds: ReadonlySet<string>,
): T[] {
  const live = stored.filter((session) => !archivedIds.has(session.id));
  if (!nativeSnapshot) return live;

  const byId = new Map<string, T>(
    nativeSnapshot
      .filter((session) => !archivedIds.has(session.id))
      .map((session) => [session.id, { ...session }]),
  );
  for (const session of live) {
    const native = byId.get(session.id);
    byId.set(session.id, native ? {
      ...native,
      ...session,
      title: session.title && session.title !== "Untitled" ? session.title : native.title,
      messagePreview: session.messagePreview || native.messagePreview,
      ...mergeSessionTimestamps(session, native),
    } : session);
  }
  return [...byId.values()].sort(
    (left, right) => new Date(right.lastActive).getTime() - new Date(left.lastActive).getTime(),
  );
}

/**
 * Serialises native session scans, keeping at most one queued re-run.
 *
 * A request that arrives mid-scan cannot be answered by the scan already
 * running: that one started before whatever prompted the request, so its
 * result is stale by the time it lands. Dropping the request instead leaves
 * the stale list published until some unrelated event happens to trigger the
 * next scan. Queueing one re-run bounds the work at one extra scan no matter
 * how many requests arrive while a scan is in flight.
 */
export function createNativeRefreshCoordinator(
  run: (reason: string) => Promise<void>,
): (reason: string) => void {
  let inFlight: Promise<void> | null = null;
  let queuedReason: string | null = null;

  const start = (reason: string): void => {
    inFlight = run(reason)
      .catch(() => {})
      .then(() => {
        inFlight = null;
        const next = queuedReason;
        queuedReason = null;
        if (next !== null) start(next);
      });
  };

  return (reason: string): void => {
    if (inFlight) {
      queuedReason = reason;
      return;
    }
    start(reason);
  };
}
