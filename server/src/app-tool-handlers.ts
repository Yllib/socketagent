import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import type { Backend, CodexDriver, ServerMessage } from "./protocol";
import { generateKokoroAudio } from "./kokoro-tts";
import { saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";
import { listSkills, SkillEntry } from "./skills-manager";
import { requestSecureInput, SecureInputRequestArgs, SecureInputRequestStatus } from "./secure-input-store";
import { sendPushNotification } from "./push-notifications";
import { saveHtmlPlan } from "./html-plan-store";
import { removeHtmlPlanHistoryEntries } from "./session-store";

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
  description: string;
  outputFile: string;
  lastSize: number;
  readerInterval: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  outputBuffer: string[];
  process?: ChildProcess;
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

  ctx.send({
    type: "scheduled_task_notification",
    title,
    body,
    sessionId: ctx.getSessionId(),
    status: "manual",
  } as any);
  sendPushNotification({
    title,
    body,
    sessionId: ctx.getSessionId(),
    status: "manual",
    kind: "tool_notification",
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
    content: body ? `${title}\n${body}` : title,
    status: "manual",
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

function startMonitorReader(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  stopMonitorReader(taskId);
  state.readerInterval = setInterval(() => {
    try {
      if (!fs.existsSync(state.outputFile)) return;
      const stat = fs.statSync(state.outputFile);
      if (stat.size <= state.lastSize) return;

      const fd = fs.openSync(state.outputFile, "r");
      const buf = Buffer.alloc(stat.size - state.lastSize);
      fs.readSync(fd, buf, 0, buf.length, state.lastSize);
      fs.closeSync(fd);
      state.lastSize = stat.size;

      const lines = buf.toString("utf8").split("\n").filter((line) => line.length > 0);
      if (lines.length === 0) return;
      state.outputBuffer.push(...lines);
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => flushMonitorBuffer(taskId), 5000);
    } catch (err: any) {
      console.error(`[AppMonitor] Reader error for ${taskId}: ${err.message}`);
    }
  }, 1000);
}

function stopMonitorReader(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state) return;
  if (state.readerInterval) clearInterval(state.readerInterval);
  state.readerInterval = null;
}

function flushMonitorBuffer(taskId: string): void {
  const state = appMonitors.get(taskId);
  if (!state || state.outputBuffer.length === 0) return;
  const deliveredLines = state.outputBuffer.length;
  const content = state.outputBuffer.slice(0, deliveredLines).join("\n");
  const text = `[Monitor: "${state.description}" (${taskId})]\n${content}`;

  if (state.ctx.isRunning?.() && state.ctx.injectMessage) {
    state.ctx.injectMessage(text, "next").then(
      () => { state.outputBuffer.splice(0, deliveredLines); },
      (err) => { console.error(`[AppMonitor] Inject error for ${taskId}: ${err.message}`); },
    );
  } else {
    state.outputBuffer.splice(0, deliveredLines);
    state.ctx.onMonitorOutput?.(text);
  }
}

export function stopAppMonitor(taskId: string, flush = true, killProcess = false): boolean {
  const state = appMonitors.get(taskId);
  if (!state) return false;
  stopMonitorReader(taskId);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  if (flush) flushMonitorBuffer(taskId);
  if (killProcess && state.process && !state.process.killed) {
    state.process.kill("SIGTERM");
  }
  appMonitors.delete(taskId);
  return true;
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

    const command = args.command;
    const description = args.description || command.slice(0, 60);
    const taskId = `monitor-${crypto.randomUUID().slice(0, 8)}`;
    const outputFile = `/tmp/socketagent-monitor-${taskId}.log`;
    const fd = fs.openSync(outputFile, "w");
    const child = spawn(command, [], {
      shell: true,
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: ctx.getCwd?.() || process.cwd(),
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(fd);

    const state: AppMonitorState = {
      ctx,
      description,
      outputFile,
      lastSize: 0,
      readerInterval: null,
      debounceTimer: null,
      timeoutTimer: null,
      outputBuffer: [],
      process: child,
    };
    appMonitors.set(taskId, state);
    startMonitorReader(taskId);

    if (args.timeoutSeconds) {
      state.timeoutTimer = setTimeout(() => {
        console.log(`[AppMonitor] Timeout reached for ${taskId}`);
        stopAppMonitor(taskId, true);
      }, args.timeoutSeconds * 1000);
    }

    ctx.send({ type: "task_started", taskId, toolUseId: `monitor-${taskId}`, description, taskType: "monitor", sessionId: ctx.getSessionId() } as any);
    ctx.send({ type: "monitor_started", taskId, description, monitoring: true, command, sessionId: ctx.getSessionId() } as any);

    child.on("exit", (code, signal) => {
      const exitMsg = `[Monitor: "${description}" (${taskId})] Process exited with code ${code ?? "unknown"} (signal: ${signal || "none"})`;
      flushMonitorBuffer(taskId);
      ctx.onMonitorOutput?.(exitMsg);
      stopAppMonitor(taskId, false);
      ctx.send({
        type: "task_notification",
        taskId,
        status: code === 0 ? "completed" : "failed",
        summary: `Process exited with code ${code ?? "unknown"}`,
        sessionId: ctx.getSessionId(),
      } as any);
    });

    return { content: [{ type: "text", text: `Process started and monitoring enabled. Task ID: ${taskId}. PID: ${child.pid || "unknown"}.${args.timeoutSeconds ? ` Monitoring timeout: ${args.timeoutSeconds}s.` : ""}` }] };
  } catch (e: any) {
    console.error(`[AppMonitor] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `Monitor error: ${e.message}` }], isError: true };
  }
}
