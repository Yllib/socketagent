import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { ServerMessage } from "./protocol";
import { generateKokoroAudio } from "./kokoro-tts";
import { saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";

export interface AppToolContext {
  getSessionId(): string;
  getCwd?(): string;
  send(msg: ServerMessage | Record<string, any>): void;
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

export interface ScheduleTaskArgs {
  prompt: string;
  cwd: string;
  scheduledTime: string;
  recurrenceType?: "once" | "daily" | "weekly" | "monthly" | "custom";
  customIntervalMs?: number;
  reuseSession?: boolean;
}

export interface MonitorArgs {
  command?: string;
  description?: string;
  timeoutSeconds?: number;
  taskId?: string;
  enabled?: boolean;
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
    return { content: [{ type: "text", text: "Speaking to user." }] };
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
    const fileId = crypto.createHash("md5").update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest("hex").slice(0, 12);

    const now = Date.now();
    if (recentSendFiles.has(fileId) && now - recentSendFiles.get(fileId)! < 10000) {
      const sizeStr = sizeLabel(stat.size);
      console.log(`[MCP:SendFile] Dedup: ${fileName} already sent recently, skipping`);
      return { content: [{ type: "text", text: `File already sent: ${fileName} (${sizeStr})` }] };
    }
    recentSendFiles.set(fileId, now);

    ctx.send({
      type: "file",
      fileId,
      fileName,
      filePath,
      fileSize: stat.size,
      sessionId: ctx.getSessionId(),
    } as any);

    const sizeStr = sizeLabel(stat.size);
    console.log(`[MCP:SendFile] Returning result for ${fileName} (${sizeStr})`);
    return { content: [{ type: "text", text: `File ready for download: ${fileName} (${sizeStr})` }] };
  } catch (e: any) {
    console.error(`[MCP:SendFile] Error: ${e.message}`, e.stack);
    return { content: [{ type: "text", text: `SendFile error: ${e.message}` }], isError: true };
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

  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    prompt: args.prompt,
    cwd: args.cwd,
    scheduledTime: args.scheduledTime,
    createdAt: new Date().toISOString(),
    status: "pending",
    createdBySessionId: ctx.getSessionId() || undefined,
    recurrence,
    reuseSession: args.reuseSession || false,
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
  return { content: [{ type: "text", text: `Task scheduled for ${when}${recurrenceLabel} in ${args.cwd}:\n"${args.prompt.slice(0, 300)}"` }] };
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
    const outputFile = `/tmp/socketclaude-monitor-${taskId}.log`;
    const fd = fs.openSync(outputFile, "w");
    const child = spawn(command, [], {
      shell: true,
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: ctx.getCwd?.() || process.cwd(),
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
