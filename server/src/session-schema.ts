import { z } from "zod";
import { sessionRunOutcomeSchema } from "./history-schema";
import type {
  AgentSessionSettings, AgentThinkingSetting, SessionInfo,
  SessionRunCurrent, SessionRunRecord, SessionRunStats, UsageInfo,
} from "./protocol";

type Shape<T> = { [K in keyof T]-?: z.ZodType<T[K]> };
const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const optionalBoolean = z.boolean().optional();
const backendSchema = z.enum(["claude", "codex"]);

const thinkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adaptive") }).passthrough(),
  z.object({ type: z.literal("enabled"), budgetTokens: z.number() }).passthrough(),
  z.object({ type: z.literal("disabled") }).passthrough(),
]) satisfies z.ZodType<AgentThinkingSetting>;

export const agentSessionSettingsSchema = z.object({
  model: optionalText, effort: optionalText, thinking: thinkingSchema.optional(),
  codexFastMode: optionalBoolean, codexCollaborationMode: optionalText,
  claudeAutoCompact: optionalBoolean, claudeAutoCompactWindow: optionalNumber,
  disallowedTools: z.array(z.string()).optional(), systemPrompt: optionalText,
  additionalDirectories: z.array(z.string()).optional(),
  connectedAppApprovals: z.array(z.string()).optional(),
} satisfies Shape<AgentSessionSettings>).passthrough();

const usageSchema = z.object({
  inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(),
  cacheCreateTokens: z.number(), contextWindow: z.number(),
} satisfies Shape<UsageInfo>).passthrough();

const runRecordSchema = z.object({
  runId: z.string(), runNumber: z.number(), startedAt: z.string(), finishedAt: z.string(),
  durationMs: z.number(), outcome: sessionRunOutcomeSchema,
  source: z.enum(["observed", "sdk_backfill", "transcript_estimate"]).optional(),
} satisfies Shape<SessionRunRecord>).passthrough();

const currentRunSchema = z.object({
  runId: z.string(), startedAt: z.string(), supervisorSettled: optionalBoolean,
  pendingOutcome: sessionRunOutcomeSchema.optional(),
} satisfies Shape<SessionRunCurrent>).passthrough();

export const runStatsSchema = z.object({
  current: currentRunSchema.optional(), completedCount: z.number(),
  totalDurationMs: z.number(), averageDurationMs: optionalNumber,
  longestDurationMs: optionalNumber, shortestDurationMs: optionalNumber,
  lastCompletedAt: optionalText, recentRuns: z.array(runRecordSchema).optional(),
  backfillVersion: optionalNumber,
} satisfies Shape<SessionRunStats>).passthrough();

export const sessionInfoSchema = z.object({
  id: z.string(), title: z.string(), cwd: z.string(), createdAt: z.string(),
  lastActive: z.string(), messagePreview: z.string(),
  turnCount: optionalNumber, historyCount: optionalNumber,
  replacedSessionIds: z.array(z.string()).optional(), compactionsSinceRollover: optionalNumber,
  freshThreadPending: optionalBoolean, running: optionalBoolean, activeStartedAt: optionalText,
  runStats: runStatsSchema.optional(),
  lastUsage: usageSchema.extend({ costUsd: optionalNumber, numTurns: optionalNumber }).optional(),
  lastContextUsage: z.record(z.string(), z.unknown()).optional(),
  scheduledTaskId: optionalText, backend: backendSchema.optional(),
  // Older metadata names the retired exec driver; all current sessions use app-server.
  codexDriver: z.enum(["app-server", "exec"]).transform(() => "app-server" as const).optional(),
  codexInstructionDelivery: z.object({ threadId: z.string(), digest: z.string() }).passthrough().optional(),
  permissionMode: optionalText, agentSettings: agentSessionSettingsSchema.optional(),
  contextClearedAt: optionalText, pendingHandoffContext: optionalText,
  transferLineage: z.object({
    transferId: optionalText, sourceSessionId: z.string(), sourceBackend: backendSchema,
    sourceServerLabel: optionalText, transferredAt: z.string(), mode: z.enum(["move", "clone"]),
  }).passthrough().optional(),
  delegatedBySessionId: optionalText, delegationId: optionalText,
  delegationSupervisorSessionId: optionalText,
} satisfies Shape<SessionInfo>).passthrough();

const sessionsSchema = z.array(sessionInfoSchema);

export function parseStoredSessions(value: unknown): SessionInfo[] {
  return sessionsSchema.parse(value);
}
