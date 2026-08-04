import * as crypto from "crypto";
import type {
  SessionRunOutcome,
  SessionRunStats,
} from "./protocol";
import { appendHistory, getSession, saveSession } from "./session-store";
import type { DelegatedAgentRecord } from "./delegated-agent-types";

function emptyStats(): SessionRunStats {
  return {
    completedCount: 0,
    totalDurationMs: 0,
  };
}

function normalizedStats(stats?: SessionRunStats): SessionRunStats {
  const completedCount = Math.max(0, Math.trunc(stats?.completedCount || 0));
  const totalDurationMs = Math.max(0, Math.trunc(stats?.totalDurationMs || 0));
  return {
    ...emptyStats(),
    ...stats,
    completedCount,
    totalDurationMs,
    ...(completedCount > 0
      ? { averageDurationMs: Math.round(totalDurationMs / completedCount) }
      : {}),
  };
}

export function hasOutstandingDelegatedRuns(
  records: DelegatedAgentRecord[],
  logicalRunStartedAt: string,
  reportQueueActive = false,
): boolean {
  if (reportQueueActive) return true;
  const startedMs = new Date(logicalRunStartedAt).getTime();
  return records.some((record) => record.runs.some((run) => {
    if (new Date(run.startedAt).getTime() < startedMs) return false;
    if (run.status === "starting" || run.status === "running") return true;
    return run.reportStatus !== "delivered";
  }));
}

export function getSessionRunStats(sessionId: string): SessionRunStats | undefined {
  const stats = getSession(sessionId)?.runStats;
  return stats ? normalizedStats(stats) : undefined;
}

export function beginSessionRun(
  sessionId: string,
  startedAt = new Date().toISOString(),
  runId: string = crypto.randomUUID(),
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const stats = normalizedStats(session.runStats);
  if (!stats.current) {
    stats.current = { runId, startedAt, supervisorSettled: false };
    session.runStats = stats;
    saveSession(session);
  }
  return normalizedStats(stats);
}

export function setSessionRunSupervisorSettled(
  sessionId: string,
  settled: boolean,
  pendingOutcome?: SessionRunOutcome,
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session?.runStats?.current) return session?.runStats;
  const stats = normalizedStats(session.runStats);
  stats.current = {
    ...stats.current!,
    supervisorSettled: settled,
    ...(settled && pendingOutcome ? { pendingOutcome } : {}),
    ...(!settled ? { pendingOutcome: undefined } : {}),
  };
  session.runStats = stats;
  saveSession(session);
  return normalizedStats(stats);
}

export function finishSessionRun(
  sessionId: string,
  outcome: SessionRunOutcome,
  finishedAt = new Date().toISOString(),
): SessionRunStats | undefined {
  const session = getSession(sessionId);
  if (!session?.runStats?.current) return session?.runStats;

  const stats = normalizedStats(session.runStats);
  const current = stats.current!;
  const startMs = new Date(current.startedAt).getTime();
  const finishMs = new Date(finishedAt).getTime();
  const durationMs = Math.max(
    0,
    Number.isFinite(startMs) && Number.isFinite(finishMs) ? finishMs - startMs : 0,
  );
  const completedCount = stats.completedCount + 1;
  const totalDurationMs = stats.totalDurationMs + durationMs;
  const next: SessionRunStats = {
    completedCount,
    totalDurationMs,
    averageDurationMs: Math.round(totalDurationMs / completedCount),
    longestDurationMs: stats.longestDurationMs == null
      ? durationMs
      : Math.max(stats.longestDurationMs, durationMs),
    shortestDurationMs: stats.shortestDurationMs == null
      ? durationMs
      : Math.min(stats.shortestDurationMs, durationMs),
    lastCompletedAt: finishedAt,
    recentRuns: [
      ...(stats.recentRuns || []),
      {
        runId: current.runId,
        runNumber: completedCount,
        startedAt: current.startedAt,
        finishedAt,
        durationMs,
        outcome,
      },
    ].slice(-500),
  };
  session.runStats = next;
  saveSession(session);

  appendHistory(sessionId, {
    role: "run_boundary",
    content: "Run finished",
    timestamp: finishedAt,
    runId: current.runId,
    runNumber: completedCount,
    runStartedAt: current.startedAt,
    runFinishedAt: finishedAt,
    runDurationMs: durationMs,
    runOutcome: outcome,
  });
  return normalizedStats(next);
}
