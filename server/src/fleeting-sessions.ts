import type { SessionInfo, SessionLifetime } from "./protocol";
import type { AgentSessionToolArgs } from "./delegated-agent-types";

/** A fleeting session is deleted after this long with no turn running. */
export const FLEETING_IDLE_MS = 6 * 60 * 60 * 1000;

export const SESSION_LIFETIMES: readonly SessionLifetime[] = ["fleeting", "permanent"];

export function isFleeting(session: Pick<SessionInfo, "lifetime">): boolean {
  return session.lifetime === "fleeting";
}

/**
 * The last moment the session did anything, as the idle clock sees it.
 * lastActive moves on prompts and results; a run that finished without a
 * result (an abort, say) still counts through its completion time, so a
 * session is never deleted the instant a long turn ends.
 */
export function fleetingIdleSince(session: SessionInfo): number {
  const candidates = [
    session.lastActive,
    session.createdAt,
    session.runStats?.lastCompletedAt,
    session.runStats?.current?.startedAt,
  ];
  let latest = 0;
  for (const value of candidates) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest;
}

/** ISO time an idle fleeting session will be deleted. Undefined when permanent. */
export function fleetingExpiresAt(session: SessionInfo): string | undefined {
  if (!isFleeting(session)) return undefined;
  return new Date(fleetingIdleSince(session) + FLEETING_IDLE_MS).toISOString();
}

/**
 * Fleeting sessions whose idle time has run out. `isBusy` answers for live
 * state the stored record cannot see: a running turn, a pending question or
 * approval, outstanding delegated work, a run being recovered after restart.
 */
export function expiredFleetingSessions(
  sessions: readonly SessionInfo[],
  options: { now?: number; isBusy: (session: SessionInfo) => boolean },
): SessionInfo[] {
  const now = options.now ?? Date.now();
  return sessions.filter((session) =>
    isFleeting(session)
    && !options.isBusy(session)
    && fleetingIdleSince(session) + FLEETING_IDLE_MS <= now);
}

export const LIFETIME_GUIDANCE =
  "fleeting for investigations, lookups and throwaway helpers (deleted after six idle hours unless the user keeps it), "
  + "permanent for implementation work the user will want to revisit.";

/**
 * The lifetime an agent named for a new child. Enforced where the agent makes
 * the call, so the error tells it exactly what to send.
 */
export function requireStartLifetime(args: Pick<AgentSessionToolArgs, "lifetime">): SessionLifetime {
  const lifetime = args.lifetime;
  if (lifetime === "fleeting" || lifetime === "permanent") return lifetime;
  throw new Error(
    `action=start requires lifetime: "fleeting" or "permanent". Use ${LIFETIME_GUIDANCE}`,
  );
}

export function fleetingChildExpiredMessage(sessionId: string, expiredAt: string): string {
  return `Child session ${sessionId} was fleeting and sat idle past six hours, so it was deleted at ${expiredAt}`
    + " along with its transcript. Start a new child for further work.";
}
