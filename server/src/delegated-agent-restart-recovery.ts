import type { DelegatedAgentRecord, DelegatedAgentStatus } from "./delegated-agent-types";
import type { HistoryEntry } from "./protocol";

const RESTART_CONTINUATION_PREFIX =
  "[System: The server restart completed successfully";

export interface DelegatedRestartContinuation {
  startedAt: string;
  status: Extract<DelegatedAgentStatus, "running" | "completed">;
  completedAt?: string;
  result?: string;
}
function timestampMs(value: string | undefined): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFinalAssistant(entry: HistoryEntry): boolean {
  const content = entry.content.trim();
  return entry.role === "assistant"
    && !entry.thinking
    && !entry.parentToolUseId
    && content.length > 0
    && !content.startsWith("[Server restart")
    && !content.startsWith("[compact_boundary:");
}

/**
 * Find a restart continuation that happened after the last run tracked by the
 * delegation registry. Older servers resumed the native child session but
 * detached that continuation from its delegation, so its real completion
 * could never wake the supervisor.
 */
export function findUntrackedDelegatedRestartContinuation(
  record: DelegatedAgentRecord,
  history: HistoryEntry[],
): DelegatedRestartContinuation | undefined {
  if (record.status === "stopped") return undefined;
  if (record.runs.some((run) => run.status === "running" || run.status === "starting")) {
    return undefined;
  }

  const trackedThrough = record.runs.reduce(
    (latest, run) => Math.max(
      latest,
      timestampMs(run.completedAt),
      timestampMs(run.startedAt),
    ),
    0,
  );
  const restartPrompt = [...history].reverse().find((entry) =>
    entry.role === "user"
    && entry.content.startsWith(RESTART_CONTINUATION_PREFIX)
    && timestampMs(entry.timestamp) > trackedThrough,
  );
  if (!restartPrompt) return undefined;

  const startedAtMs = timestampMs(restartPrompt.timestamp);
  const boundary = history.find((entry) =>
    entry.role === "run_boundary"
    && timestampMs(entry.timestamp) >= startedAtMs,
  );
  if (!boundary) {
    return {
      startedAt: restartPrompt.timestamp,
      status: "running",
    };
  }

  const completedAtMs = timestampMs(boundary.timestamp);
  const reply = [...history].reverse().find((entry) => {
    const at = timestampMs(entry.timestamp);
    return at >= startedAtMs && at <= completedAtMs && isFinalAssistant(entry);
  });
  const result = reply?.content.trim()
    || "The delegated restart continuation completed without a final text response.";
  return {
    startedAt: restartPrompt.timestamp,
    status: "completed",
    completedAt: boundary.timestamp,
    result: result.length <= 50_000
      ? result
      : `${result.slice(0, 50_000)}\n\n[Delegated result truncated by SocketAgent]`,
  };
}
