import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Backend, CodexDriver, ServerMessage } from "./protocol";
import { generateKokoroAudio } from "./kokoro-tts";
import { getScheduledTaskSessionIds, saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";
import { listSkills, SkillEntry } from "./skills-manager";
import { requestSecureInput, SecureInputRequestArgs, SecureInputRequestStatus } from "./secure-input-store";
import { sendPushNotification } from "./push-notifications";
import { saveHtmlPlan } from "./html-plan-store";
import {
  getTodos,
  removeHtmlPlanHistoryEntries,
  saveTodos,
} from "./session-store";
import { fileTransferVersion } from "./file-transfer-wire";
import {
  createDurableMonitorRecord,
  DurableMonitorRecord,
  getDurableMonitorRecord,
  launchDurableMonitor,
  listDurableMonitorRecords,
  readDurableMonitorSlice,
  removeDurableMonitorRecord,
  stopDurableMonitor,
  stopDurableMonitorAndWait,
  updateDurableMonitorRecord,
} from "./durable-monitor-store";
import type {
  AgentSessionToolArgs,
  AgentSessionToolExecutor,
  DelegatedAgentRecord,
} from "./delegated-agent-types";

export interface AppToolContext {
  getSessionId(): string;
  getCwd?(): string;
  getBackend?(): Backend;
  getCodexDriver?(): CodexDriver;
  send(msg: ServerMessage | Record<string, any>): void;
  appendHistory?(entry: Record<string, any>): Record<string, any> | void;
  getTtsEngine(): "system" | "kokoro_server" | "kokoro_device";
  getKokoroVoice(): string;
  getKokoroSpeed(): number;
  isRunning?(): boolean;
  injectMessage?(text: string, priority?: "now" | "next" | "later"): Promise<void>;
  onMonitorOutput?(text: string): void;
  manageAgentSession?: AgentSessionToolExecutor;
  reportSubagentAssignment?(agentPath: string, prompt: string): boolean;
}

export interface McpTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ReminderArgs {
  title: string;
  body?: string;
  scheduledTime: string;
}

export interface NotifyUserArgs {
  title: string;
  body?: string;
}

export interface ScheduleTaskArgs {
  name?: string;
  prompt: string;
  cwd: string;
  backend?: Backend;
  codexDriver?: CodexDriver;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra";
  permissionMode?: string;
  scheduledTime: string;
  recurrenceType?: "once" | "daily" | "weekly" | "monthly" | "custom";
  customIntervalMs?: number;
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
}

export interface MonitorArgs {
  command?: string;
  description?: string;
  timeoutSeconds?: number;
  taskId?: string;
  enabled?: boolean;
}

export interface TaskBatchItem {
  task_id?: string;
  subject?: string;
  description?: string;
  active_form?: string;
  status?: "pending" | "in_progress" | "completed";
  owner?: string;
  blocked_by?: string[];
  blocks?: string[];
}

export interface TaskBatchArgs {
  mode: "replace" | "upsert" | "delete" | "clear_completed" | "list";
  tasks?: TaskBatchItem[];
  task_ids?: string[];
}

export interface ReportSubagentAssignmentArgs {
  agent_path: string;
  prompt: string;
}

const SOCKETAGENT_TASK_SOURCE = "socketagent_tasks";
const TASK_BATCH_LIMIT = 200;

export async function handleReportSubagentAssignmentTool(
  ctx: AppToolContext,
  args: ReportSubagentAssignmentArgs,
): Promise<McpTextResult> {
  const agentPath = String(args.agent_path || "").trim();
  const prompt = String(args.prompt || "").trim();
  if (!agentPath || !prompt) {
    return {
      content: [{ type: "text", text: "Both agent_path and prompt are required." }],
      isError: true,
    };
  }
  if (!ctx.reportSubagentAssignment) {
    return {
      content: [{ type: "text", text: "Subagent assignment reporting is unavailable in this session." }],
      isError: true,
    };
  }
  if (!ctx.reportSubagentAssignment(agentPath, prompt)) {
    return {
      content: [{ type: "text", text: `No active SocketAgent subagent matches ${agentPath}.` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: "Assignment attached to the subagent card." }],
  };
}

function batchTaskId(existingIds: Set<string>): string {
  while (true) {
    const candidate = `sa-${crypto.randomUUID().slice(0, 12)}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

function boundedTaskText(
  value: unknown,
  field: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  const text = String(value).trim();
  if (!text && required) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return text || undefined;
}

function taskBatchView(task: Record<string, any>): Record<string, unknown> {
  return {
    task_id: String(task.id || task.taskId || ""),
    subject: String(task.content || ""),
    description: String(task.description || ""),
    active_form: String(task.activeForm || task.content || ""),
    status: String(task.status || "pending"),
    ...(task.owner ? { owner: String(task.owner) } : {}),
    blocked_by: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : [],
  };
}

function taskFromBatchItem(
  item: TaskBatchItem,
  id: string,
  previous?: Record<string, any>,
): Record<string, any> {
  const subject = boundedTaskText(
    item.subject ?? previous?.content,
    "subject",
    500,
    true,
  )!;
  const description = boundedTaskText(
    item.description ?? previous?.description,
    "description",
    10_000,
  );
  const activeForm = boundedTaskText(
    item.active_form ?? previous?.activeForm ?? subject,
    "active_form",
    500,
  ) || subject;
  const status = item.status || previous?.status || "pending";
  const owner = boundedTaskText(item.owner ?? previous?.owner, "owner", 500);
  const blockedBy = (item.blocked_by ?? previous?.blockedBy ?? [])
    .map(String)
    .filter(Boolean)
    .slice(0, TASK_BATCH_LIMIT);
  const blocks = (item.blocks ?? previous?.blocks ?? [])
    .map(String)
    .filter(Boolean)
    .slice(0, TASK_BATCH_LIMIT);
  return {
    ...(previous || {}),
    id,
    taskId: id,
    content: subject,
    activeForm,
    status,
    source: SOCKETAGENT_TASK_SOURCE,
    ...(description ? { description } : {}),
    ...(owner ? { owner } : {}),
    blockedBy,
    blocks,
  };
}

export async function handleTaskBatchTool(
  ctx: AppToolContext,
  args: TaskBatchArgs,
): Promise<McpTextResult> {
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return {
      content: [{ type: "text", text: "TaskBatch requires an active SocketAgent session." }],
      isError: true,
    };
  }
  try {
    const current = getTodos(sessionId);
    const otherTasks = current.filter(
      (task) => task?.source !== SOCKETAGENT_TASK_SOURCE,
    );
    let managed = current
      .filter((task) => task?.source === SOCKETAGENT_TASK_SOURCE)
      .map((task) => ({ ...task }));
    const existingIds = new Set(
      managed.map((task) => String(task.id || task.taskId || "")).filter(Boolean),
    );
    const items = args.tasks || [];
    if (items.length > TASK_BATCH_LIMIT) {
      throw new Error(`TaskBatch accepts at most ${TASK_BATCH_LIMIT} tasks per call`);
    }

    switch (args.mode) {
      case "replace":
      {
        const requestedIds = new Set<string>();
        managed = items.map((item) => {
          const requestedId = boundedTaskText(item.task_id, "task_id", 200);
          if (requestedId && requestedIds.has(requestedId)) {
            throw new Error(`Duplicate SocketAgent task id: ${requestedId}`);
          }
          if (requestedId) requestedIds.add(requestedId);
          const id = requestedId || batchTaskId(existingIds);
          if (existingIds.has(id) && !requestedId) {
            throw new Error("Could not allocate a unique task id");
          }
          existingIds.add(id);
          return taskFromBatchItem(item, id);
        });
        break;
      }
      case "upsert":
      {
        const requestedIds = new Set<string>();
        for (const item of items) {
          const requestedId = boundedTaskText(item.task_id, "task_id", 200);
          if (requestedId && requestedIds.has(requestedId)) {
            throw new Error(`Duplicate SocketAgent task id: ${requestedId}`);
          }
          if (requestedId) requestedIds.add(requestedId);
          const index = requestedId
            ? managed.findIndex(
                (task) => String(task.id || task.taskId || "") === requestedId,
              )
            : -1;
          if (requestedId && index < 0) {
            throw new Error(`Unknown SocketAgent task id: ${requestedId}`);
          }
          const id = requestedId || batchTaskId(existingIds);
          existingIds.add(id);
          const updated = taskFromBatchItem(
            item,
            id,
            index >= 0 ? managed[index] : undefined,
          );
          if (index >= 0) managed[index] = updated;
          else managed.push(updated);
        }
        break;
      }
      case "delete": {
        const ids = new Set((args.task_ids || []).map(String).filter(Boolean));
        if (ids.size > TASK_BATCH_LIMIT) {
          throw new Error(`TaskBatch accepts at most ${TASK_BATCH_LIMIT} task_ids per call`);
        }
        managed = managed.filter(
          (task) => !ids.has(String(task.id || task.taskId || "")),
        );
        break;
      }
      case "clear_completed":
        managed = managed.filter((task) => task.status !== "completed");
        break;
      case "list":
        break;
      default:
        throw new Error(`Unsupported TaskBatch mode: ${String(args.mode)}`);
    }

    const next = [...otherTasks, ...managed];
    if (args.mode !== "list" && JSON.stringify(next) !== JSON.stringify(current)) {
      saveTodos(sessionId, next);
      ctx.appendHistory?.({
        role: "todos_update",
        content: JSON.stringify(next),
        timestamp: new Date().toISOString(),
      });
      ctx.send({
        type: "todos",
        todos: next,
        sessionId,
      });
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mode: args.mode,
          count: managed.length,
          tasks: managed.map(taskBatchView),
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: `TaskBatch error: ${error?.message || String(error)}`,
      }],
      isError: true,
    };
  }
}

function delegatedAgentSummary(
  record: DelegatedAgentRecord,
  includeResult = true,
): Record<string, unknown> {
  const latestRun = record.runs.at(-1);
  const result = latestRun?.result;
  return {
    delegation_id: record.delegationId,
    session_id: record.childSessionId || null,
    backend: record.backend,
    cwd: record.cwd,
    label: record.label,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    run_count: record.runs.length,
    ...(latestRun ? {
      latest_run: {
        run_id: latestRun.runId,
        run_number: latestRun.runNumber,
        status: latestRun.status,
        started_at: latestRun.startedAt,
        completed_at: latestRun.completedAt || null,
        result: includeResult && result
          ? (result.length <= 12_000 ? result : `${result.slice(0, 12_000)}\n[truncated]`)
          : null,
        error: latestRun.error || null,
        report_status: latestRun.reportStatus || null,
      },
    } : {}),
  };
}

export async function handleAgentSessionTool(
  ctx: AppToolContext,
  args: AgentSessionToolArgs,
): Promise<McpTextResult> {
  if (!ctx.manageAgentSession) {
    return {
      content: [{ type: "text", text: "AgentSession is unavailable because this SocketAgent session is not attached to the delegation runtime." }],
      isError: true,
    };
  }
  try {
    const response = await ctx.manageAgentSession(args);
    if (response.delegations) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            response.delegations.map((record) => delegatedAgentSummary(record, false)),
            null,
            2,
          ),
        }],
      };
    }
    if (!response.delegation) {
      return {
        content: [{ type: "text", text: response.message || "AgentSession request completed." }],
      };
    }
    const record = response.delegation;
    const summary = delegatedAgentSummary(record);
    const guidance = response.action === "start"
      ? `\nUse action="message" with session_id="${record.childSessionId}" for follow-ups. The child will report back automatically when its turn finishes.`
      : "";
    return {
      content: [{
        type: "text",
        text: `${response.message || "AgentSession request completed."}\n${JSON.stringify(summary, null, 2)}${guidance}`,
      }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `AgentSession error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

/**
 * A `pgrep -f 'literal'` watcher sees the literal in its own parent shell's
 * argv and therefore never finishes. Bracketed patterns such as `[f]oo` are
 * safe because the regex matches the target argv but not its own source text.
 */
export function monitorCommandHasSelfMatchingPgrep(command: string): boolean {
  const pgrepPattern = /\bpgrep\s+((?:(?:-[A-Za-z]+|--full)\s+)*)(["'])(.*?)\2/g;
  for (const match of command.matchAll(pgrepPattern)) {
    const flags = match[1] || "";
    if (!flags.includes("--full") && !/(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(flags)) {
      continue;
    }
    try {
      if (new RegExp(match[3]).test(match[3])) return true;
    } catch {
      // Let the shell report malformed regex syntax rather than guessing.
    }
  }
  return false;
}

export interface SearchSkillsArgs {
  query?: string;
  limit?: number;
}

export interface ReadSkillArgs {
  name?: string;
  filePath?: string;
}

export type RequestSecureInputArgs = SecureInputRequestArgs;

export interface HtmlPlanArgs {
  title: string;
  html: string;
  plan_id?: string;
}

interface AppMonitorState {
  ctx: AppToolContext;
  record: DurableMonitorRecord;
  description: string;
  outputFile: string;
  lastSize: number;
  agentReadOffset: number;
  agentPendingEnd: number;
  readerInterval: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<boolean> | null;
  outputBuffer: string[];
  completing: boolean;
}

const recentSendFiles: Map<string, number> = new Map();
const appMonitors: Map<string, AppMonitorState> = new Map();

export async function handleHtmlPlanTool(
  ctx: AppToolContext,
  args: HtmlPlanArgs,
): Promise<McpTextResult> {
  try {
    const sessionId = ctx.getSessionId();
    const saved = saveHtmlPlan({
      sessionId,
      title: args.title,
      html: args.html,
      planId: args.plan_id,
    });
    removeHtmlPlanHistoryEntries(sessionId, saved.planId);
    const positioned = ctx.appendHistory?.({
      role: "html_plan",
      content: saved.title,
      toolName: "HtmlPlan",
      toolInput: saved,
      toolUseId: `html_plan_${saved.planId}`,
      timestamp: saved.updatedAt,
    }) as Record<string, any> | undefined;
    ctx.send({
      type: "html_plan",
      ...saved,
      ...(positioned?.entryId ? { entryId: positioned.entryId } : {}),
      ...(positioned?.sessionSeq ? { sessionSeq: positioned.sessionSeq } : {}),
      ...(positioned?.revision ? { revision: positioned.revision } : {}),
    });
    return {
      content: [{
        type: "text",
        text: `HTML plan presented to the user. Plan ID: ${saved.planId}. Reuse this plan_id to update it instead of creating another plan.`,
      }],
    };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `HTML plan error: ${e.message || String(e)}` }],
      isError: true,
    };
  }
}

function appendVisibleToolHistory(
  ctx: AppToolContext,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  extra: Record<string, unknown> = {},
): void {
  if (!ctx.appendHistory) return;
  const toolUseId = `mcp_${toolName}_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  ctx.appendHistory({
    role: "tool_call",
    content: JSON.stringify(toolInput),
    toolName,
    toolInput,
    toolUseId,
    timestamp,
    ...extra,
  });
  ctx.appendHistory({
    role: "tool_result",
    content: toolOutput,
    toolUseId,
    toolOutput,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function sizeLabel(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

export async function handleSpeakTool(
  ctx: AppToolContext,
  args: { text: string },
): Promise<McpTextResult> {
  try {
    console.log(`[MCP:Speak] Called with ${args.text.length} chars`);
    ctx.send({
      type: "speak",
      text: args.text,
      sessionId: ctx.getSessionId(),
    } as any);

    if (ctx.getTtsEngine() === "kokoro_server") {
      try {
        const wavBuffer = generateKokoroAudio(args.text, ctx.getKokoroVoice(), ctx.getKokoroSpeed());
        if (wavBuffer) {
          ctx.send({
            type: "tts_audio",
            audioData: wavBuffer.toString("base64"),
            text: args.text,
            sessionId: ctx.getSessionId(),
          } as any);
        }
      } catch (e) {
        console.error("[KokoroTTS] Error generating audio:", e);
      }
    }

    console.log("[MCP:Speak] Returning result");
    const resultText = "Speaking to user.";
    appendVisibleToolHistory(ctx, "Speak", { text: args.text }, resultText);
    return { content: [{ type: "text", text: resultText }] };
  } catch (e: any) {
    console.error(`[MCP:Speak] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `Speak error: ${e.message}` }], isError: true };
  }
}

export async function handleSendFileTool(
  ctx: AppToolContext,
  args: { file_path: string },
): Promise<McpTextResult> {
  try {
    const filePath = args.file_path;
    console.log(`[MCP:SendFile] Called with path=${filePath}`);
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: "text", text: `File not found: ${filePath}` }] };
    }
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    // File availability is session-owned. Including the session in the ID
    // prevents an identically-named/path file advertised by another running
    // session from taking over the active card's download route in the app.
    const sessionId = ctx.getSessionId();
    const fileId = crypto.createHash("md5")
      .update(`${sessionId}:${filePath}:${stat.mtimeMs}:${stat.size}`)
      .digest("hex")
      .slice(0, 12);

    const now = Date.now();
    if (recentSendFiles.has(fileId) && now - recentSendFiles.get(fileId)! < 10000) {
      console.log(`[MCP:SendFile] Dedup: ${fileName} was sent recently; replaying availability`);
    }
    recentSendFiles.set(fileId, now);

    ctx.send({
      type: "file",
      fileId,
      fileName,
      filePath,
      fileSize: stat.size,
      fileVersion: fileTransferVersion(stat),
      sessionId,
    });

    const sizeStr = sizeLabel(stat.size);
    console.log(`[MCP:SendFile] Returning result for ${fileName} (${sizeStr})`);
    const resultText = `File ready for download: ${fileName} (${sizeStr})`;
    // The Claude SDK and Codex app-server both persist their own canonical
    // tool_call/tool_result pair. Writing another synthetic pair here made
    // the same card occupy two history offsets and move across page loads.
    return { content: [{ type: "text", text: resultText }] };
  } catch (e: any) {
    console.error(`[MCP:SendFile] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `SendFile error: ${e.message}` }], isError: true };
  }
}

export async function handleRequestSecureInputTool(
  ctx: AppToolContext,
  args: RequestSecureInputArgs,
): Promise<McpTextResult> {
  const label = (args.label || "").trim() || "Secret";
  try {
    const saved = await requestSecureInput(
      (msg) => ctx.send(msg),
      {
        label,
        reason: args.reason,
        envHint: args.envHint,
        scope: args.scope,
        timeoutSeconds: args.timeoutSeconds,
      },
      ctx.getSessionId(),
      ctx.getCwd?.(),
      (request, status: SecureInputRequestStatus) => {
        if (!ctx.appendHistory) return;
        const requestId = String(request.requestId || "");
        const reason = String(request.reason || "");
        ctx.appendHistory({
          role: "secure_input",
          content: reason,
          questionId: requestId,
          answered: status !== "pending",
          status,
          toolInput: {
            label: String(request.label || label),
            reason,
            envHint: String(request.envHint || ""),
            scope: String(request.scope || "session"),
            multiline: request.multiline === true,
            status,
          },
          timestamp: new Date().toISOString(),
        });
      },
    );
    const resultText = [
      "Secure input saved.",
      `Label: ${saved.label}`,
      `Secret ID: ${saved.secretId}`,
      `Scope: ${saved.scope}`,
      `File path: ${saved.filePath}`,
      `Suggested env var: ${saved.envHint}`,
      "",
      "Use the file path or suggested env var name in commands. Do not print the secret value.",
    ].join("\n");
    appendVisibleToolHistory(
      ctx,
      "RequestSecureInput",
      { label, reason: args.reason || "", scope: saved.scope, envHint: saved.envHint },
      resultText,
    );
    return { content: [{ type: "text", text: resultText }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Secure input request failed: ${e.message || e}` }], isError: true };
  }
}

export async function handleScheduleReminderTool(
  ctx: AppToolContext,
  args: ReminderArgs,
): Promise<McpTextResult> {
  const scheduledDate = new Date(args.scheduledTime);
  if (isNaN(scheduledDate.getTime())) {
    return { content: [{ type: "text", text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
  }
  if (scheduledDate.getTime() <= Date.now()) {
    return { content: [{ type: "text", text: "Scheduled time is in the past. Please provide a future time." }] };
  }

  const hash = crypto.createHash("md5").update(`${args.title}:${args.scheduledTime}`).digest();
  const notificationId = Math.abs(hash.readInt32BE(0));

  ctx.send({
    type: "reminder",
    title: args.title,
    body: args.body || "",
    scheduledTime: args.scheduledTime,
    notificationId,
    sessionId: ctx.getSessionId(),
  } as any);

  const when = scheduledDate.toLocaleString();
  return { content: [{ type: "text", text: `Reminder scheduled: "${args.title}" at ${when}` }] };
}

export async function handleNotifyUserTool(
  ctx: AppToolContext,
  args: NotifyUserArgs,
): Promise<McpTextResult> {
  const title = args.title.trim();
  const body = (args.body || "").trim();
  if (!title) {
    return { content: [{ type: "text", text: "NotifyUser error: title is required" }], isError: true };
  }

  const eventId = `tool_notification:${ctx.getSessionId() || "none"}:${crypto.randomUUID()}`;
  const fromScheduledTask = getScheduledTaskSessionIds().has(ctx.getSessionId());

  ctx.send({
    type: "scheduled_task_notification",
    title,
    body,
    sessionId: ctx.getSessionId(),
    status: "manual",
    kind: "tool_notification",
    eventId,
    ...(fromScheduledTask ? { navigationTarget: "scheduled_tasks" } : {}),
    // The tool handler owns delivery. Headless task forwarding must not send
    // this same event through FCM a second time.
    fcmDispatched: true,
  } as any);
  sendPushNotification({
    title,
    body,
    sessionId: ctx.getSessionId(),
    status: "manual",
    kind: "tool_notification",
    data: {
      eventId,
      ...(fromScheduledTask ? { navigationTarget: "scheduled_tasks" } : {}),
    },
    showNotification: false,
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for NotifyUser session=${ctx.getSessionId() || "none"}`);
    }
  }).catch((err) => {
    console.warn(`[Push] NotifyUser push error: ${err?.message || err}`);
  });
  ctx.appendHistory?.({
    role: "notification",
    entryId: eventId,
    content: body ? `${title}\n${body}` : title,
    status: "manual",
    toolInput: {
      kind: "notify_user",
      title,
      body,
    },
    timestamp: new Date().toISOString(),
  });

  return { content: [{ type: "text", text: `Notification sent: "${title}"` }] };
}

export async function handleScheduleTaskTool(
  ctx: AppToolContext,
  args: ScheduleTaskArgs,
): Promise<McpTextResult> {
  const scheduledDate = new Date(args.scheduledTime);
  if (isNaN(scheduledDate.getTime())) {
    return { content: [{ type: "text", text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
  }
  if (scheduledDate.getTime() <= Date.now()) {
    return { content: [{ type: "text", text: "Scheduled time is in the past. Please provide a future time." }] };
  }

  const recurrenceType = args.recurrenceType || "once";
  const recurrence: RecurrenceConfig | undefined = recurrenceType !== "once" ? {
    type: recurrenceType,
    intervalMs: recurrenceType === "custom" ? args.customIntervalMs : undefined,
  } : undefined;

  const backend = args.backend || ctx.getBackend?.() || "claude";
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    ...(args.name?.trim() ? { name: args.name.trim() } : {}),
    prompt: args.prompt,
    cwd: args.cwd,
    backend,
    ...(backend === "codex"
      ? { codexDriver: "app-server" as CodexDriver }
      : {}),
    ...(args.model?.trim() ? { model: args.model.trim() } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    scheduledTime: args.scheduledTime,
    createdAt: new Date().toISOString(),
    status: "pending",
    createdBySessionId: ctx.getSessionId() || undefined,
    recurrence,
    reuseSession: args.reuseSession || false,
    notificationMode: args.notificationMode === "quiet" ? "quiet" : "completion",
    runCount: 0,
    runs: [],
  };
  saveScheduledTask(task);

  ctx.send({
    type: "scheduled_task_update",
    task,
  } as any);

  const when = scheduledDate.toLocaleString();
  const recurrenceLabel = recurrence ? ` (recurring: ${recurrence.type})` : "";
  const notificationLabel = task.notificationMode === "quiet" ? " Quiet mode is on." : "";
  const label = task.name ? `"${task.name}"` : "Task";
  return { content: [{ type: "text", text: `${label} scheduled for ${when}${recurrenceLabel} in ${args.cwd}.${notificationLabel}\n"${args.prompt.slice(0, 300)}"` }] };
}

function codexSkillsForContext(ctx: AppToolContext): SkillEntry[] {
  return listSkills(ctx.getCwd?.()).filter((skill) => skill.agent === "codex" && skill.format === "skill");
}

function skillSummary(skill: SkillEntry): string {
  const description = skill.description ? ` - ${skill.description}` : "";
  return `${skill.name} (${skill.scope})${description}\npath: ${skill.filePath}`;
}

export async function handleSearchSkillsTool(
  ctx: AppToolContext,
  args: SearchSkillsArgs,
): Promise<McpTextResult> {
  const query = (args.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Math.floor(args.limit || 10), 1), 25);
  let skills = codexSkillsForContext(ctx);
  if (query) {
    skills = skills.filter((skill) => {
      const haystack = [
        skill.name,
        skill.description,
        skill.scope,
        skill.pluginName || "",
        skill.body.slice(0, 1000),
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  }
  skills = skills.slice(0, limit);
  if (skills.length === 0) {
    return { content: [{ type: "text", text: "No matching Codex skills found." }] };
  }
  return {
    content: [{
      type: "text",
      text: skills.map(skillSummary).join("\n\n"),
    }],
  };
}

export async function handleReadSkillTool(
  ctx: AppToolContext,
  args: ReadSkillArgs,
): Promise<McpTextResult> {
  const name = (args.name || "").trim().toLowerCase();
  const filePath = (args.filePath || "").trim();
  const skills = codexSkillsForContext(ctx);
  const skill = filePath
    ? skills.find((candidate) => path.resolve(candidate.filePath) === path.resolve(filePath))
    : skills.find((candidate) => candidate.name.toLowerCase() === name);

  if (!skill) {
    return { content: [{ type: "text", text: "Codex skill not found." }], isError: true };
  }

  const frontmatter = Object.entries(skill.frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const header = [
    `name: ${skill.name}`,
    `scope: ${skill.scope}`,
    `path: ${skill.filePath}`,
    frontmatter,
  ].filter(Boolean).join("\n");

  return {
    content: [{
      type: "text",
      text: `---\n${header}\n---\n\n${skill.body}`,
    }],
  };
}

function publishMonitorOutput(taskId: string, content: string): void {
  const state = appMonitors.get(taskId);
  if (!state || !content) return;
  const sessionId = state.record.sessionId;
  const cumulative = readDurableMonitorSlice(state.record, 0).content;
  const positioned = state.ctx.appendHistory?.({
    role: "monitor",
    content: cumulative,
    taskId,
    description: state.description,
    toolInput: { snapshot: true },
    timestamp: new Date().toISOString(),
  });
  state.ctx.send({
    type: "monitor_output",
    taskId,
    content,
    snapshotContent: cumulative,
    description: state.description,
    snapshot: true,
    sessionId,
    ...((positioned && typeof positioned === "object") ? {
      entryId: (positioned as any).entryId,
      sessionSeq: (positioned as any).sessionSeq,
      revision: (positioned as any).revision,
    } : {}),
  } as any);
}

/** Read every byte written since the last poll before reporting/injecting it. */
function readMonitorOutput(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state || !fs.existsSync(state.outputFile)) return;
  try {
    const phoneSlice = readDurableMonitorSlice(state.record, state.lastSize);
    if (phoneSlice.end > state.lastSize) {
      state.lastSize = phoneSlice.end;
      publishMonitorOutput(taskId, phoneSlice.content);
      updateDurableMonitorRecord(taskId, { phoneOffset: phoneSlice.end });
    }

    const agentSlice = readDurableMonitorSlice(state.record, state.agentReadOffset);
    if (agentSlice.end > state.agentReadOffset) {
      const lines = agentSlice.content.split("\n").filter((line) => line.length > 0);
      state.agentReadOffset = agentSlice.end;
      state.agentPendingEnd = agentSlice.end;
      state.outputBuffer.push(...lines);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void flushMonitorBuffer(taskId);
      }, 5000);
    }
  } catch (err: any) {
    console.error(`[AppMonitor] Reader error for ${taskId}: ${err.message}`);
  }
}

function startMonitorReader(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  stopMonitorReader(taskId);
  state.readerInterval = setInterval(() => {
    readMonitorOutput(taskId);
    const latest = getDurableMonitorRecord(taskId);
    if (!latest || state.completing || (latest.status !== "completed" && latest.status !== "failed")) return;
    state.completing = true;
    stopMonitorReader(taskId);
    readMonitorOutput(taskId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    void flushMonitorBuffer(taskId).then((delivered) => {
      if (delivered) {
        const exitCode = latest.exitCode ?? "unknown";
        finishAppMonitor(taskId, latest.status as "completed" | "failed", `Process exited with code ${exitCode}`);
      } else if (appMonitors.get(taskId) === state) {
        state.completing = false;
        startMonitorReader(taskId);
      }
    });
  }, 500);
}

function stopMonitorReader(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  if (state.readerInterval) clearInterval(state.readerInterval);
  state.readerInterval = null;
}

async function deliverMonitorBuffer(taskId: string, state: AppMonitorState): Promise<boolean> {
  if (state.outputBuffer.length === 0) return true;
  const deliveredLines = state.outputBuffer.length;
  const deliveredEnd = state.agentPendingEnd;
  const content = state.outputBuffer.slice(0, deliveredLines).join("\n");
  const text = `[Monitor: "${state.description}" (${taskId})]\n${content}`;

  if (state.ctx.isRunning?.() && state.ctx.injectMessage) {
    try {
      await state.ctx.injectMessage(text, "next");
      state.outputBuffer.splice(0, deliveredLines);
      updateDurableMonitorRecord(taskId, { agentOffset: deliveredEnd });
      return true;
    } catch (err: any) {
      state.agentReadOffset = getDurableMonitorRecord(taskId)?.agentOffset || 0;
      state.outputBuffer = [];
      console.error(`[AppMonitor] Inject error for ${taskId}: ${err.message}`);
      return false;
    }
  }

  state.outputBuffer.splice(0, deliveredLines);
  updateDurableMonitorRecord(taskId, { agentOffset: deliveredEnd });
  state.ctx.onMonitorOutput?.(text);
  return true;
}

async function flushMonitorBuffer(taskId: string): Promise<boolean> {
  const state = appMonitors.get(taskId);
  if (!state) return true;

  // A debounce flush can overlap the terminal flush. Serialize deliveries so
  // the completion path cannot remove the durable record while a newer chunk
  // is still waiting behind an in-flight agent injection.
  if (state.flushPromise) {
    const active = state.flushPromise;
    const delivered = await active;
    if (state.flushPromise === active) state.flushPromise = null;
    if (!delivered) return false;
    return flushMonitorBuffer(taskId);
  }

  if (state.outputBuffer.length === 0) return true;
  const delivery = deliverMonitorBuffer(taskId, state);
  state.flushPromise = delivery;
  const delivered = await delivery;
  if (state.flushPromise === delivery) state.flushPromise = null;
  if (!delivered) return false;
  return state.outputBuffer.length > 0 ? flushMonitorBuffer(taskId) : true;
}

function finishAppMonitor(taskId: string, status: "completed" | "failed", summary: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  stopMonitorReader(taskId);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  appMonitors.delete(taskId);
  removeDurableMonitorRecord(taskId);
  state.ctx.send({
    type: "monitor_started",
    taskId,
    description: state.description,
    monitoring: false,
    sessionId: state.record.sessionId,
  } as any);
  state.ctx.send({
    type: "task_notification",
    taskId,
    status,
    summary,
    sessionId: state.record.sessionId,
  } as any);
}

export function stopAppMonitor(taskId: string, flush = true, killProcess = false): boolean {
  const state = appMonitors.get(taskId);
  if (!state) return false;
  stopMonitorReader(taskId);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  if (flush) {
    readMonitorOutput(taskId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    void flushMonitorBuffer(taskId);
  }
  appMonitors.delete(taskId);
  stopDurableMonitor(taskId, killProcess);
  state.ctx.send({
    type: "monitor_started",
    taskId,
    description: state.description,
    monitoring: false,
    sessionId: state.record.sessionId,
  } as any);
  return true;
}

/** Hard-stop every Monitor process owned by a SocketAgent session. */
export async function stopAppMonitorsForSession(sessionId: string): Promise<number> {
  const owned = [...appMonitors.entries()].filter(([, state]) =>
    state.record.sessionId === sessionId,
  );
  for (const [taskId, state] of owned) {
    stopMonitorReader(taskId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    appMonitors.delete(taskId);
    state.ctx.send({
      type: "monitor_started",
      taskId,
      description: state.description,
      monitoring: false,
      sessionId,
    } as any);
  }
  await Promise.all(owned.map(([taskId]) => stopDurableMonitorAndWait(taskId, true)));
  return owned.length;
}

function scheduleMonitorTimeout(taskId: string, state: AppMonitorState): void {
  if (!state.record.timeoutAt) return;
  const remaining = new Date(state.record.timeoutAt).getTime() - Date.now();
  if (remaining <= 0) {
    stopAppMonitor(taskId, true, false);
    return;
  }
  state.timeoutTimer = setTimeout(() => {
    console.log(`[AppMonitor] Timeout reached for ${taskId}`);
    stopAppMonitor(taskId, true, false);
  }, remaining);
}

export function restoreAppMonitors(
  contextFor: (record: DurableMonitorRecord) => AppToolContext,
): number {
  let restored = 0;
  for (const record of listDurableMonitorRecords()) {
    if (appMonitors.has(record.taskId)) continue;
    const state: AppMonitorState = {
      ctx: contextFor(record),
      record,
      description: record.description,
      outputFile: record.outputFile,
      lastSize: record.phoneOffset || 0,
      agentReadOffset: record.agentOffset || 0,
      agentPendingEnd: record.agentOffset || 0,
      readerInterval: null,
      debounceTimer: null,
      timeoutTimer: null,
      flushPromise: null,
      outputBuffer: [],
      completing: false,
    };
    appMonitors.set(record.taskId, state);
    startMonitorReader(record.taskId);
    scheduleMonitorTimeout(record.taskId, state);
    state.ctx.send({
      type: "task_started",
      taskId: record.taskId,
      toolUseId: `monitor-${record.taskId}`,
      description: record.description,
      taskType: "monitor",
      sessionId: record.sessionId,
    } as any);
    state.ctx.send({
      type: "monitor_started",
      taskId: record.taskId,
      description: record.description,
      monitoring: true,
      command: record.command,
      sessionId: record.sessionId,
    } as any);
    restored++;
  }
  return restored;
}

export function activeAppMonitorRecords(): DurableMonitorRecord[] {
  return listDurableMonitorRecords();
}

/**
 * Detach live monitor delivery from a completed agent turn. Future output uses
 * the durable server router, which can resume the correct session even after
 * the original SDK object or phone connection has gone away.
 */
export function rebindAppMonitorsForSession(
  sessionId: string,
  contextFor: (record: DurableMonitorRecord) => AppToolContext,
): number {
  let rebound = 0;
  for (const state of appMonitors.values()) {
    if (state.record.sessionId !== sessionId) continue;
    state.ctx = contextFor(state.record);
    rebound++;
  }
  return rebound;
}

export async function handleMonitorTool(
  ctx: AppToolContext,
  args: MonitorArgs,
): Promise<McpTextResult> {
  try {
    if (args.taskId && !args.command) {
      const enabled = args.enabled !== false;
      if (!enabled) {
        return stopAppMonitor(args.taskId, true)
          ? { content: [{ type: "text", text: `Monitoring disabled for task ${args.taskId}. Process continues running.` }] }
          : { content: [{ type: "text", text: `Task ${args.taskId} is not being monitored.` }] };
      }
      return { content: [{ type: "text", text: "Codex can only toggle monitors that were started with the Monitor tool in this session." }], isError: true };
    }

    if (!args.command) {
      return { content: [{ type: "text", text: "Monitor requires either 'command' to start a monitored process or 'taskId' with enabled=false to stop monitoring." }], isError: true };
    }

    if (monitorCommandHasSelfMatchingPgrep(args.command)) {
      return {
        content: [{
          type: "text",
          text: "Monitor refused a self-matching `pgrep -f` command: the watcher shell contains the same pattern, so it would run forever. Monitor an exact PID/pidfile, or use a non-self-matching regex such as `pgrep -f '[f]etch_music.py --only'`.",
        }],
        isError: true,
      };
    }

    const sessionId = ctx.getSessionId();
    if (!sessionId) {
      return {
        content: [{
          type: "text",
          text: "Monitor could not start before the native session ID was available. Retry the Monitor call.",
        }],
        isError: true,
      };
    }
    const command = args.command;
    const description = args.description || command.slice(0, 60);
    const taskId = `monitor-${crypto.randomUUID().slice(0, 8)}`;
    const record = launchDurableMonitor(createDurableMonitorRecord({
      taskId,
      sessionId,
      backend: ctx.getBackend?.() || "codex",
      cwd: ctx.getCwd?.() || process.cwd(),
      command,
      description,
      timeoutSeconds: args.timeoutSeconds,
    }));

    const state: AppMonitorState = {
      ctx,
      record,
      description,
      outputFile: record.outputFile,
      lastSize: 0,
      agentReadOffset: 0,
      agentPendingEnd: 0,
      readerInterval: null,
      debounceTimer: null,
      timeoutTimer: null,
      flushPromise: null,
      outputBuffer: [],
      completing: false,
    };
    appMonitors.set(taskId, state);
    startMonitorReader(taskId);

    scheduleMonitorTimeout(taskId, state);

    ctx.send({ type: "task_started", taskId, toolUseId: `monitor-${taskId}`, description, taskType: "monitor", sessionId } as any);
    ctx.send({ type: "monitor_started", taskId, description, monitoring: true, command, sessionId } as any);

    let launched = record;
    for (let i = 0; i < 20 && !launched.processPid && launched.status === "starting"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      launched = getDurableMonitorRecord(taskId) || launched;
    }
    return { content: [{ type: "text", text: `Process started and monitoring enabled. Task ID: ${taskId}. PID: ${launched.processPid || "starting"}.${args.timeoutSeconds ? ` Monitoring timeout: ${args.timeoutSeconds}s.` : ""}` }] };
  } catch (e: any) {
    console.error(`[AppMonitor] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `Monitor error: ${e.message}` }], isError: true };
  }
}
