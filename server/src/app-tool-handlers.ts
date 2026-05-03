import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ServerMessage } from "./protocol";
import { generateKokoroAudio } from "./kokoro-tts";

export interface AppToolContext {
  getSessionId(): string;
  send(msg: ServerMessage | Record<string, any>): void;
  getTtsEngine(): "system" | "kokoro_server" | "kokoro_device";
  getKokoroVoice(): string;
  getKokoroSpeed(): number;
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

const recentSendFiles: Map<string, number> = new Map();

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
