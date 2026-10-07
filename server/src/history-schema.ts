import { z } from "zod";
import type {
  EmailPreview, HistoryEntry, QuestionItem, SessionRunOutcome,
  WorkflowPhaseState, WorkflowProgressState, WorkflowStatePayload,
} from "./protocol";

// Require a validator for every declared field, including optional fields.
// Passthrough retains fields written by newer servers during a downgrade.
type Shape<T> = { [K in keyof T]-?: z.ZodType<T[K]> };
const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const optionalBoolean = z.boolean().optional();
const unknownRecord = z.record(z.string(), z.unknown());

const questionSchema = z.object({
  question: z.string(),
  header: optionalText,
  options: z.array(z.object({
    label: z.string(), description: optionalText, preview: optionalText,
  }).passthrough()),
  multiSelect: optionalBoolean,
} satisfies Shape<QuestionItem>).passthrough();

const emailPreviewSchema = z.object({
  to: z.string(), subject: z.string(), body: z.string(),
  cc: optionalText, attachment: optionalText, scheduledTime: optionalText,
} satisfies Shape<EmailPreview>).passthrough();

const workflowPhaseSchema = z.object({
  title: z.string(), detail: optionalText,
} satisfies Shape<WorkflowPhaseState>).passthrough();

const workflowProgressSchema = z.object({
  type: z.string(), index: optionalNumber, title: optionalText,
  label: optionalText, phaseIndex: optionalNumber, phaseTitle: optionalText,
  agentId: optionalText, model: optionalText, state: optionalText,
  startedAt: optionalNumber, queuedAt: optionalNumber, lastProgressAt: optionalNumber,
  tokens: optionalNumber, toolCalls: optionalNumber, durationMs: optionalNumber,
  attempt: optionalNumber, promptPreview: optionalText, resultPreview: optionalText,
  error: optionalText,
} satisfies Shape<WorkflowProgressState>).passthrough();

const workflowStateSchema = z.object({
  taskId: z.string(), toolUseId: optionalText, runId: optionalText,
  workflowName: optionalText, summary: z.string(), status: z.string(),
  scriptPath: optionalText, transcriptDir: optionalText, statePath: optionalText,
  startTime: optionalNumber, durationMs: optionalNumber, agentCount: optionalNumber,
  totalTokens: optionalNumber, totalToolCalls: optionalNumber, defaultModel: optionalText,
  phases: z.array(workflowPhaseSchema), progress: z.array(workflowProgressSchema),
  logs: z.array(z.string()), resultPreview: optionalText,
} satisfies Shape<WorkflowStatePayload>).passthrough();

export const sessionRunOutcomeSchema = z.enum([
  "completed", "stopped", "failed",
]) satisfies z.ZodType<SessionRunOutcome>;

export const historyEntrySchema = z.object({
  role: z.enum([
    "user", "assistant", "tool_call", "tool_result", "tool_image", "question",
    "secure_input", "browser_session", "html_plan", "work_review", "todos_update",
    "codex_plan", "user_uuid", "elicitation_url", "prompt_suggestion", "monitor",
    "notification", "task_state", "permission_mode", "run_boundary", "system",
    "error",
  ]).transform(role => role === "system" ? "notification" : role),
  // Older tool cards can omit these display fields. Do not invent a timestamp.
  content: z.string().default(""), timestamp: z.string().default(""),
  inlineImageContent: optionalText, toolName: optionalText,
  toolInput: unknownRecord.optional(), toolUseId: optionalText, toolOutput: optionalText,
  backgroundPending: optionalBoolean, fileId: optionalText, fileName: optionalText,
  fileSize: optionalNumber, fileVersion: optionalText, fileDeliveryPath: optionalText,
  toolOutputRef: optionalText, toolOutputBytes: optionalNumber,
  toolOutputStoredBytes: optionalNumber, toolOutputPreview: optionalText,
  toolOutputEncoding: z.literal("gzip").optional(),
  questionId: optionalText, questions: z.array(questionSchema).optional(),
  asyncQuestion: optionalBoolean, emailPreview: emailPreviewSchema.optional(),
  answered: optionalBoolean, answers: z.record(z.string(), z.string()).optional(),
  authRequest: z.object({
    kind: z.string(), requestId: z.string(), startUrl: z.string(),
    captureOrigins: z.array(z.string()),
  }).passthrough().optional(),
  subagentStatus: optionalText, parentToolUseId: z.string().nullable().optional(),
  uuid: optionalText, triggerUserMessageUuid: optionalText,
  triggerUserMessageUuids: z.array(z.string()).optional(),
  messagePhase: z.enum(["commentary", "final_answer"]).optional(),
  toolSummary: optionalBoolean, precedingToolUseIds: z.array(z.string()).optional(),
  thinking: optionalBoolean, thinkingTokens: optionalNumber, thinkingDurationMs: optionalNumber,
  filePath: optionalText, mimeType: optionalText, mcpServerName: optionalText, url: optionalText,
  taskId: optionalText, description: optionalText, status: optionalText,
  originToolUseId: optionalText, taskType: optionalText,
  taskKind: z.enum(["claude_task", "subagent", "workflow", "background"]).optional(),
  taskSubject: optionalText, taskDescription: optionalText, teammateName: optionalText,
  progressSummary: optionalText, lastToolName: optionalText, isBackgrounded: optionalBoolean,
  skipTranscript: optionalBoolean, subagentType: optionalText,
  taskUsage: z.object({
    totalTokens: z.number(), toolUses: z.number(), durationMs: z.number(),
  }).passthrough().optional(),
  workflowState: workflowStateSchema.optional(), commandName: optionalText,
  commandPayload: unknownRecord.optional(), permissionMode: optionalText,
  runId: optionalText, runNumber: optionalNumber, runStartedAt: optionalText,
  runFinishedAt: optionalText, runDurationMs: optionalNumber,
  runOutcome: sessionRunOutcomeSchema.optional(), reviewId: optionalText,
  workReview: unknownRecord.optional(), entryId: optionalText, sessionSeq: optionalNumber,
  revision: optionalNumber, streamId: optionalText,
} satisfies Shape<HistoryEntry>).passthrough();

export function parseHistoryEntry(value: unknown): HistoryEntry {
  return historyEntrySchema.parse(value);
}

export function parseHistoryEntries(value: unknown): HistoryEntry[] {
  return z.array(historyEntrySchema).parse(value);
}
