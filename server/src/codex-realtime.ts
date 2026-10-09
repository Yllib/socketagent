import { z } from "zod";
import type { CodexAppServerClient, CodexAppServerNotification } from "./codex-app-server-client";
import type { CodexRealtimeEvent, CodexRealtimeTranscriptRole, ServerMessage } from "./protocol";

/**
 * Realtime voice for Codex sessions.
 *
 * Codex app-server exposes an experimental `thread/realtime/*` API that joins a
 * thread to an OpenAI realtime voice session. With a ChatGPT sign-in only the
 * WebRTC transport works (the websocket transport insists on an API key), so
 * the phone owns the peer connection: it sends an SDP offer, we pass it to
 * `thread/realtime/start`, and the SDP answer comes back through
 * `thread/realtime/sdp`. Audio then flows between the phone and OpenAI
 * directly. Codex stays attached through its own sideband socket, which is
 * where transcripts and handoffs to the backing Codex model come from. We
 * forward those to the phone as `codex_realtime_event` messages and record
 * finished transcript segments in the session history.
 */

// The contract generator only covers methods it has been told about, and the
// checked-in contracts predate this CLI. These mirror the generated shapes for
// codex-cli 0.162.0 and move into generated/codex once the contracts are
// regenerated with the realtime methods listed.
export type CodexRealtimeTransport =
  | { type: "websocket" }
  | { type: "webrtc"; sdp: string }
  | { type: "existingCall"; callId: string };

export interface CodexRealtimeMethods {
  "thread/realtime/start": {
    params: {
      threadId: string;
      transport?: CodexRealtimeTransport | null;
      outputModality: "text" | "audio";
      version?: "v1" | "v2" | "v3" | null;
      voice?: string | null;
      flushTranscriptTailOnSessionEnd?: boolean | null;
      prompt?: string | null;
    };
    response: Record<string, never>;
  };
  "thread/realtime/stop": { params: { threadId: string }; response: Record<string, never> };
  "thread/realtime/appendText": {
    params: { threadId: string; text: string; role: "user" | "developer" | "assistant" };
    response: Record<string, never>;
  };
  "thread/realtime/listVoices": {
    params: Record<string, never>;
    response: { voices: { v1: string[]; v2: string[]; defaultV1: string; defaultV2: string } };
  };
}

/** The WebRTC call path only accepts the frameless v3 protocol. */
export const CODEX_REALTIME_VERSION = "v3";

const transcriptRole = z.enum(["user", "assistant"]);
const threadScoped = z.object({ threadId: z.string() });
const startedSchema = threadScoped.extend({
  realtimeSessionId: z.string().nullable().optional(),
  version: z.string().optional(),
});
const sdpSchema = threadScoped.extend({ sdp: z.string() });
const transcriptDeltaSchema = threadScoped.extend({ role: z.string(), delta: z.string() });
const transcriptDoneSchema = threadScoped.extend({ role: z.string(), text: z.string() });
const itemSchema = threadScoped.extend({
  item: z.object({
    id: z.string(),
    type: z.string(),
    role: transcriptRole.optional(),
    text: z.string().optional(),
  }),
});
const itemDeltaSchema = threadScoped.extend({ itemId: z.string(), delta: z.string() });
const errorSchema = threadScoped.extend({ message: z.string() });
const closedSchema = threadScoped.extend({ reason: z.string().nullable().optional() });
const voicesSchema = z.object({
  voices: z.object({ v1: z.array(z.string()), defaultV1: z.string() }),
});

export interface CodexRealtimeVoices {
  voices: string[];
  defaultVoice: string;
}

/** Voices accepted by the frameless (v3) call path share the v1 list. */
export function parseRealtimeVoices(response: unknown): CodexRealtimeVoices {
  const parsed = voicesSchema.safeParse(response);
  if (!parsed.success) throw new Error("Codex returned an invalid realtime voice list");
  return { voices: parsed.data.voices.v1, defaultVoice: parsed.data.voices.defaultV1 };
}

export interface CodexRealtimeStartOptions {
  sdp: string;
  voice?: string;
  requestId?: string;
}

export interface CodexRealtimeBridgeOptions {
  client: Pick<CodexAppServerClient, "on" | "off" | "request">;
  threadId: string;
  sessionId: string;
  send: (message: ServerMessage) => void;
  /** Called with each finished transcript segment so the chat keeps the call. */
  recordTranscript?: (role: CodexRealtimeTranscriptRole, text: string) => void;
  /** Called once when the realtime session ends for any reason. */
  onClosed?: () => void;
}

/**
 * Normalises Codex realtime notifications for one thread into
 * `codex_realtime_event` messages. Both transcript flavours are handled: the
 * flat `transcript/delta` stream and the item-scoped stream where a
 * `transcriptSegment` item starts, receives deltas, then completes.
 */
export class CodexRealtimeBridge {
  private active = false;
  private closed = false;
  private readonly itemRoles = new Map<string, CodexRealtimeTranscriptRole>();
  private readonly onNotification = (notification: CodexAppServerNotification) => this.handle(notification);
  private readonly onExit = () => this.finish("Codex exited");

  constructor(private readonly options: CodexRealtimeBridgeOptions) {}

  get isActive(): boolean {
    return this.active;
  }

  async start(start: CodexRealtimeStartOptions): Promise<void> {
    if (this.closed) throw new Error("This realtime session has already ended");
    if (this.active) throw new Error("A realtime session is already running");
    this.active = true;
    this.options.client.on("notification", this.onNotification);
    this.options.client.on("exit", this.onExit);
    try {
      await this.options.client.request("thread/realtime/start", {
        threadId: this.options.threadId,
        transport: { type: "webrtc", sdp: start.sdp },
        outputModality: "audio",
        version: CODEX_REALTIME_VERSION,
        flushTranscriptTailOnSessionEnd: true,
        ...(start.voice ? { voice: start.voice } : {}),
      } satisfies CodexRealtimeMethods["thread/realtime/start"]["params"]);
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    try {
      await this.options.client.request("thread/realtime/stop", {
        threadId: this.options.threadId,
      } satisfies CodexRealtimeMethods["thread/realtime/stop"]["params"]);
    } finally {
      this.finish("requested");
    }
  }

  async appendText(text: string): Promise<void> {
    if (!this.active) throw new Error("No realtime session is running");
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Nothing to send");
    await this.options.client.request("thread/realtime/appendText", {
      threadId: this.options.threadId, text: trimmed, role: "user",
    } satisfies CodexRealtimeMethods["thread/realtime/appendText"]["params"]);
  }

  /** Detach without telling Codex, for when the process is already gone. */
  dispose(): void {
    this.finish("disposed");
  }

  private emit(event: CodexRealtimeEvent, requestId?: string): void {
    this.options.send({
      type: "codex_realtime_event",
      sessionId: this.options.sessionId,
      ...(requestId ? { requestId } : {}),
      event,
    });
  }

  private finish(reason: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    this.options.client.off("notification", this.onNotification);
    this.options.client.off("exit", this.onExit);
    this.emit({ kind: "closed", reason });
    this.options.onClosed?.();
  }

  private handle({ method, params }: CodexAppServerNotification): void {
    if (!method.startsWith("thread/realtime/")) return;
    const scoped = threadScoped.safeParse(params);
    if (!scoped.success || scoped.data.threadId !== this.options.threadId) return;
    switch (method) {
      case "thread/realtime/started": {
        const parsed = startedSchema.safeParse(params);
        if (!parsed.success) return;
        this.emit({
          kind: "started",
          realtimeSessionId: parsed.data.realtimeSessionId ?? null,
          version: parsed.data.version ?? CODEX_REALTIME_VERSION,
        });
        return;
      }
      case "thread/realtime/sdp": {
        const parsed = sdpSchema.safeParse(params);
        if (parsed.success) this.emit({ kind: "answer", sdp: parsed.data.sdp });
        return;
      }
      case "thread/realtime/transcript/delta": {
        const parsed = transcriptDeltaSchema.safeParse(params);
        const role = parsed.success ? transcriptRole.safeParse(parsed.data.role) : null;
        if (!parsed.success || !role?.success || !parsed.data.delta) return;
        this.emit({ kind: "transcript_delta", role: role.data, delta: parsed.data.delta });
        return;
      }
      case "thread/realtime/transcript/done": {
        const parsed = transcriptDoneSchema.safeParse(params);
        const role = parsed.success ? transcriptRole.safeParse(parsed.data.role) : null;
        if (!parsed.success || !role?.success) return;
        this.emit({ kind: "transcript_done", role: role.data, text: parsed.data.text });
        return;
      }
      case "thread/realtime/item/started": {
        const parsed = itemSchema.safeParse(params);
        if (!parsed.success || parsed.data.item.type !== "transcriptSegment" || !parsed.data.item.role) return;
        this.itemRoles.set(parsed.data.item.id, parsed.data.item.role);
        this.emit({
          kind: "transcript_delta", role: parsed.data.item.role,
          delta: parsed.data.item.text ?? "", itemId: parsed.data.item.id,
        });
        return;
      }
      case "thread/realtime/item/transcript/delta": {
        const parsed = itemDeltaSchema.safeParse(params);
        if (!parsed.success) return;
        const role = this.itemRoles.get(parsed.data.itemId);
        if (!role) return;
        this.emit({ kind: "transcript_delta", role, delta: parsed.data.delta, itemId: parsed.data.itemId });
        return;
      }
      case "thread/realtime/item/completed": {
        const parsed = itemSchema.safeParse(params);
        if (!parsed.success) return;
        const { item } = parsed.data;
        if (item.type === "transcriptSegment") {
          const role = item.role ?? this.itemRoles.get(item.id);
          this.itemRoles.delete(item.id);
          const text = (item.text ?? "").trim();
          if (!role) return;
          this.emit({ kind: "transcript_done", role, text, itemId: item.id });
          if (text) this.options.recordTranscript?.(role, text);
        } else if (item.type === "realtimeSessionClosed") {
          // Codex publishes this before `thread/realtime/closed`; treat it as
          // authoritative so a lost closed notification cannot leave us open.
          this.finish("ended");
        }
        return;
      }
      case "thread/realtime/error": {
        const parsed = errorSchema.safeParse(params);
        this.emit({ kind: "error", message: parsed.success ? parsed.data.message : "Realtime session failed" });
        return;
      }
      case "thread/realtime/closed": {
        const parsed = closedSchema.safeParse(params);
        this.finish(parsed.success ? parsed.data.reason ?? null : null);
        return;
      }
      default:
        return;
    }
  }
}
