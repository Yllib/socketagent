import * as crypto from "crypto";
import type { DelegatedAgentRecord } from "./delegated-agent-types";
import type { HistoryEntry, SessionRunRecord } from "./protocol";

interface EngineInterval {
  startMs: number;
  endMs: number;
  outcome: SessionRunRecord["outcome"];
}

interface PromptPoint {
  timestampMs: number;
}

function timestampMs(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSyntheticPrompt(content: string): boolean {
  const text = content.trimStart();
  return text.startsWith("<socketagent_delegation_report")
    || text.startsWith("<local-command-")
    || text.startsWith("<command-name>")
    || text.startsWith("[System:")
    || text.startsWith("[Monitor:")
    || text.startsWith("[Image:")
    || text.startsWith("[Request interrupted by user]")
    || text.startsWith("[You previously asked me a question.")
    || text.startsWith("The user finished the Work Review.");
}

function lifecycleOutcome(value: unknown): SessionRunRecord["outcome"] {
  const status = String(value || "").toLowerCase();
  if (status.includes("interrupt") || status.includes("cancel") || status.includes("stop")) {
    return "stopped";
  }
  if (status && status !== "success" && status !== "completed") return "failed";
  return "completed";
}

export function extractEngineIntervals(
  events: Record<string, any>[],
): EngineInterval[] {
  const intervals: EngineInterval[] = [];
  const codexStarts = new Map<string, number>();
  for (const event of events) {
    const eventTime = timestampMs(event.ts);
    if (event.sdkType === "result" && eventTime !== undefined) {
      const durationMs = Number(event.durationMs);
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        intervals.push({
          startMs: Math.max(0, eventTime - durationMs),
          endMs: eventTime,
          outcome: lifecycleOutcome(event.subtype),
        });
      }
      continue;
    }
    if (event.method !== "turn/started" && event.method !== "turn/completed") continue;
    const turn = event.params?.turn;
    const turnId = String(turn?.id || event.params?.turnId || "");
    if (!turnId || eventTime === undefined) continue;
    if (event.method === "turn/started") {
      codexStarts.set(turnId, eventTime);
    } else {
      const durationMs = Number(turn?.durationMs);
      const startMs = Number.isFinite(durationMs) && durationMs >= 0
        ? eventTime - durationMs
        : codexStarts.get(turnId);
      if (startMs !== undefined && eventTime >= startMs) {
        intervals.push({
          startMs,
          endMs: eventTime,
          outcome: lifecycleOutcome(turn?.status),
        });
      }
    }
  }
  return intervals.sort((left, right) => left.startMs - right.startMs);
}

function promptPoints(history: HistoryEntry[]): PromptPoint[] {
  return history
    .filter((entry) => entry.role === "user" && !isSyntheticPrompt(entry.content || ""))
    .map((entry) => timestampMs(entry.timestamp))
    .filter((value): value is number => value !== undefined)
    .map((value) => ({ timestampMs: value }))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function extendThroughDelegations(
  startMs: number,
  initialEndMs: number,
  delegations: DelegatedAgentRecord[],
): number {
  let endMs = initialEndMs;
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of delegations) {
      const createdMs = timestampMs(record.createdAt);
      if (createdMs === undefined || createdMs < startMs || createdMs > endMs) continue;
      for (const run of record.runs) {
        const runStartMs = timestampMs(run.startedAt);
        const reportEndMs = timestampMs(run.reportDeliveredAt);
        if (runStartMs === undefined || reportEndMs === undefined) continue;
        if (runStartMs >= startMs && runStartMs <= endMs && reportEndMs > endMs) {
          endMs = reportEndMs;
          changed = true;
        }
      }
    }
  }
  return endMs;
}

function extendLogicalInterval(
  intervals: EngineInterval[],
  firstIndex: number,
  prompts: PromptPoint[],
  delegations: DelegatedAgentRecord[],
): { endMs: number; lastIndex: number; outcome: SessionRunRecord["outcome"] } {
  const startMs = intervals[firstIndex].startMs;
  let endMs = intervals[firstIndex].endMs;
  let lastIndex = firstIndex;
  let outcome = intervals[firstIndex].outcome;
  let changed = true;
  while (changed) {
    changed = false;
    const delegatedEnd = extendThroughDelegations(startMs, endMs, delegations);
    if (delegatedEnd > endMs) {
      endMs = delegatedEnd;
      changed = true;
    }
    // Prompts received before the current logical end are injections into the
    // same run. The first prompt after it is the boundary for a new run.
    const nextPrompt = prompts.find((prompt) => prompt.timestampMs > endMs)?.timestampMs
      ?? Number.POSITIVE_INFINITY;
    for (let index = lastIndex + 1; index < intervals.length; index++) {
      const next = intervals[index];
      if (next.startMs >= nextPrompt || next.startMs - endMs > 10_000) break;
      endMs = Math.max(endMs, next.endMs);
      lastIndex = index;
      outcome = next.outcome;
      changed = true;
    }
  }
  return { endMs, lastIndex, outcome };
}

function record(
  startMs: number,
  endMs: number,
  source: SessionRunRecord["source"],
  outcome: SessionRunRecord["outcome"] = "completed",
): SessionRunRecord {
  return {
    runId: `backfill-${crypto.createHash("sha256")
      .update(`${startMs}:${endMs}`)
      .digest("hex")
      .slice(0, 24)}`,
    runNumber: 0,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(endMs).toISOString(),
    durationMs: Math.max(0, endMs - startMs),
    outcome,
    source,
  };
}

function transcriptEstimates(
  history: HistoryEntry[],
  beforeMs = Number.POSITIVE_INFINITY,
): SessionRunRecord[] {
  const prompts = promptPoints(history).filter((point) => point.timestampMs < beforeMs);
  const assistants = history
    .filter((entry) => entry.role === "assistant" && !entry.parentToolUseId && !entry.thinking)
    .map((entry) => timestampMs(entry.timestamp))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  const records: SessionRunRecord[] = [];
  let pendingStart: number | undefined;
  for (let index = 0; index < prompts.length; index++) {
    pendingStart ??= prompts[index].timestampMs;
    const nextPrompt = prompts[index + 1]?.timestampMs ?? beforeMs;
    const reply = [...assistants].reverse().find((time) =>
      time >= prompts[index].timestampMs && time < nextPrompt,
    );
    if (reply !== undefined) {
      records.push(record(pendingStart, reply, "transcript_estimate"));
      pendingStart = undefined;
    }
  }
  return records;
}

export function deriveHistoricalRuns(
  history: HistoryEntry[],
  events: Record<string, any>[],
  delegations: DelegatedAgentRecord[] = [],
): SessionRunRecord[] {
  const intervals = extractEngineIntervals(events);
  if (intervals.length === 0) return transcriptEstimates(history);
  const prompts = promptPoints(history);
  const records: SessionRunRecord[] = [];
  let consumedThrough = -1;
  let logicalEndMs = -1;

  for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
    const prompt = prompts[promptIndex];
    if (prompt.timestampMs <= logicalEndMs) continue;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = consumedThrough + 1; index < intervals.length; index++) {
      const distance = Math.abs(intervals[index].startMs - prompt.timestampMs);
      if (intervals[index].startMs > prompt.timestampMs + 30_000) break;
      if (distance <= 30_000 && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex < 0) continue;
    const logical = extendLogicalInterval(
      intervals,
      bestIndex,
      prompts,
      delegations,
    );
    logicalEndMs = logical.endMs;
    consumedThrough = logical.lastIndex;
    records.push(record(
      intervals[bestIndex].startMs,
      logicalEndMs,
      "sdk_backfill",
      logical.outcome,
    ));
  }

  // Lifecycle capture was introduced after transcript persistence. Estimate
  // only the older prefix, never holes inside captured SDK time where an
  // unmatched user entry is much more likely to be a mid-run injection.
  const earliestLifecycle = intervals[0]?.startMs ?? Number.POSITIVE_INFINITY;
  return [
    ...transcriptEstimates(history, earliestLifecycle - 30_000),
    ...records,
  ].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}
