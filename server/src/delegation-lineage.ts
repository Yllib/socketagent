import type { SessionInfo } from "./protocol";
import type { ScheduledTask } from "./scheduled-task-store";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scheduledTaskOwnsRunSession(
  task: ScheduledTask,
  sessionId: string,
): boolean {
  if (clean(task.sessionId) === sessionId) return true;
  return (task.runs || []).some((run) => clean(run.sessionId) === sessionId);
}

/**
 * Returns the durable authorization principal for delegated agent sessions.
 *
 * A scheduled continuation runs in a fresh provider/SocketAgent session, but
 * it must retain only the delegation namespace of the session that created
 * it. Ambiguous legacy provenance fails closed to the immediate session.
 */
export function resolveDelegationSupervisorSessionId(args: {
  currentSessionId: string;
  runtimeSupervisorSessionId?: string;
  sessionInfo?: SessionInfo;
  scheduledTasks?: ScheduledTask[];
}): string {
  const currentSessionId = clean(args.currentSessionId);
  const runtime = clean(args.runtimeSupervisorSessionId);
  if (runtime) return runtime;

  const persisted = clean(args.sessionInfo?.delegationSupervisorSessionId);
  if (persisted) return persisted;

  if (!currentSessionId) return "";
  const legacyOwners = new Set(
    (args.scheduledTasks || [])
      .filter((task) => scheduledTaskOwnsRunSession(task, currentSessionId))
      .map((task) => clean(task.createdBySessionId))
      .filter(Boolean),
  );
  return legacyOwners.size === 1 ? [...legacyOwners][0] : currentSessionId;
}
