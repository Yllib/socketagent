/**
 * JSON-RPC over stdio to Google's Antigravity CLI in ACP mode (`agy acp`).
 *
 * ACP is the Agent Client Protocol, version 1. The CLI is the agent and this
 * client is the editor: we send initialize, session/new or session/resume,
 * session/prompt and session/cancel; the agent streams session/update
 * notifications and asks us session/request_permission. Google's ACP SDK is
 * ESM-only, so the few messages SocketAgent uses are typed here.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { z } from "zod";
import { PosixProcessTree } from "./posix-process-tree";

/** JSON-RPC error from the agent. Code -32000 means it needs a sign-in. */
export class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "AcpError";
  }
}

export const ACP_AUTH_REQUIRED = -32000;

const rpcErrorSchema = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
const incomingSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
});

/** A select-type session option, such as Model or Thinking level. */
export const acpConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  type: z.string(),
  currentValue: z.unknown(),
  options: z.array(z.unknown()).optional(),
}).passthrough();
export type AcpConfigOption = z.infer<typeof acpConfigOptionSchema>;

const acpModeSchema = z.object({ id: z.string(), name: z.string(), description: z.string().nullable().optional() });
const acpModesSchema = z.object({ currentModeId: z.string(), availableModes: z.array(acpModeSchema) });
const acpModelSchema = z.object({ modelId: z.string(), name: z.string(), description: z.string().nullable().optional() });
const acpModelsSchema = z.object({ currentModelId: z.string(), availableModels: z.array(acpModelSchema) });

/** What session/new, session/load and session/resume return. */
export const acpSessionSetupSchema = z.object({
  sessionId: z.string().optional(),
  modes: acpModesSchema.nullable().optional(),
  models: acpModelsSchema.nullable().optional(),
  configOptions: z.array(acpConfigOptionSchema).nullable().optional(),
}).passthrough();
export type AcpSessionSetup = z.infer<typeof acpSessionSetupSchema>;

export const acpPromptResultSchema = z.object({
  stopReason: z.string(),
  usage: z.unknown().optional(),
}).passthrough();

export const acpInitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z.object({
    loadSession: z.boolean().optional(),
    promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional(),
    sessionCapabilities: z.record(z.string(), z.unknown()).optional(),
    mcpCapabilities: z.object({ http: z.boolean().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  agentInfo: z.object({ name: z.string(), version: z.string().optional() }).passthrough().optional(),
}).passthrough();
export type AcpInitializeResult = z.infer<typeof acpInitializeResultSchema>;

/** A stdio or HTTP MCP server handed to the agent in session/new. */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface AcpNotification {
  method: string;
  params: unknown;
}

/** Answers one request the agent sent; exactly one of result or error. */
export type AcpResponder = (response: { result: unknown } | { error: { code: number; message: string } }) => void;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Ms to wait for any request except session/prompt, which runs as long as the turn. */
  requestTimeoutMs?: number;
}

/**
 * Events: "notification" (AcpNotification), "request" (method, params,
 * responder), "stderr" (chunk), "exit" (code, signal), "error" (Error).
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";

  constructor(private readonly options: AcpClientOptions) {
    super();
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  start(): void {
    if (this.proc) return;
    const proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // npm-style .cmd shims need a shell on Windows; agy ships an .exe.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.options.command),
    });
    this.proc = proc;
    // A write after agy exits fails with EPIPE; the exit handler already rejects what was pending.
    proc.stdin.on("error", () => {});
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-32 * 1024);
      this.emit("stderr", chunk);
    });
    proc.on("error", (error) => {
      // No pid means agy never started, and no exit event follows.
      if (proc.pid === undefined && this.proc === proc) this.proc = null;
      this.rejectAll(error);
      this.emit("error", error);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      this.rejectAll(new Error(`agy exited (code ${code ?? "none"}, signal ${signal ?? "none"})`));
      this.emit("exit", code, signal);
    });
  }

  async initialize(): Promise<AcpInitializeResult> {
    this.start();
    const result = await this.request("initialize", {
      protocolVersion: 1,
      // No fs or terminal capabilities: agy reads files and runs commands
      // itself, and asks permission through session/request_permission.
      // Form elicitation lets agy surface ask_question as native cards.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
      clientInfo: { name: "socketagent", title: "SocketAgent", version: "1.0.0" },
    }, 60_000);
    return acpInitializeResultSchema.parse(result);
  }

  /** Sends a request and resolves with its result. timeoutMs 0 waits forever. */
  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 60_000): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("agy is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`agy did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Stops agy and every process it started. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc?.pid) return;
    this.proc = null;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      await new PosixProcessTree(proc.pid).stop("SIGTERM", 3000);
    }
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
    this.rejectAll(new Error("agy was stopped"));
  }

  private write(message: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // agy logs to stderr; a stray stdout line is not protocol.
    }
    const parsed = incomingSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.method && message.id !== undefined && message.id !== null) {
      const id = message.id;
      let answered = false;
      const respond: AcpResponder = (response) => {
        if (answered) return;
        answered = true;
        this.write({ jsonrpc: "2.0", id, ...response });
      };
      if (this.listenerCount("request") === 0) {
        respond({ error: { code: -32601, message: `Method not supported: ${message.method}` } });
        return;
      }
      this.emit("request", message.method, message.params, respond);
      return;
    }
    if (message.method) {
      this.emit("notification", { method: message.method, params: message.params } satisfies AcpNotification);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(new AcpError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
