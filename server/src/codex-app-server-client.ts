import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export type CodexAppServerSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type CodexAppServerApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

export interface CodexAppServerUserInput {
  type: "text";
  text: string;
  text_elements?: unknown[];
}

export interface CodexAppServerClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface CodexAppServerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  stderrTailBytes?: number;
}

export interface CodexAppServerInitializeParams {
  clientInfo: CodexAppServerClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    requestAttestation?: boolean;
    [key: string]: unknown;
  };
}

export interface CodexAppServerThreadStartParams {
  cwd: string;
  sandbox?: CodexAppServerSandbox;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  model?: string;
  config?: unknown;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  [key: string]: unknown;
}

export interface CodexAppServerThreadResumeParams {
  threadId: string;
  cwd?: string;
  sandbox?: CodexAppServerSandbox;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  model?: string;
  config?: unknown;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  [key: string]: unknown;
}

export interface CodexAppServerTurnStartParams {
  threadId: string;
  input: CodexAppServerUserInput[];
  cwd?: string;
  [key: string]: unknown;
}

export interface CodexAppServerTurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: CodexAppServerUserInput[];
  responsesapiClientMetadata?: Record<string, unknown> | null;
}

export interface CodexAppServerTurnInterruptParams {
  threadId: string;
  turnId?: string;
}

export interface CodexAppServerNotification<T = unknown> {
  method: string;
  params: T;
}

interface WireResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest<T> {
  method: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest<unknown>>();
  private stdoutTail = "";
  private stderrTail = "";
  private closed = false;

  constructor(private readonly options: CodexAppServerOptions) {
    super();
  }

  get isRunning(): boolean {
    return !!this.proc && !this.proc.killed && !this.closed;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  start(): void {
    if (this.proc) return;
    this.closed = false;
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    this.proc = spawn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderrTail += chunk;
      const max = this.options.stderrTailBytes ?? 64 * 1024;
      if (this.stderrTail.length > max) this.stderrTail = this.stderrTail.slice(-max);
      this.emit("stderr", chunk);
    });

    this.proc.on("error", (err) => {
      this.rejectAll(err);
      this.emit("error", err);
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`codex app-server exited code=${code} signal=${signal}`));
      this.emit("exit", code, signal);
    });
  }

  async initialize(params: CodexAppServerInitializeParams): Promise<unknown> {
    return this.request("initialize", params, this.options.startupTimeoutMs);
  }

  async startThread(params: CodexAppServerThreadStartParams): Promise<unknown> {
    return this.request("thread/start", params);
  }

  async resumeThread(params: CodexAppServerThreadResumeParams): Promise<unknown> {
    return this.request("thread/resume", params);
  }

  async startTurn(params: CodexAppServerTurnStartParams): Promise<unknown> {
    return this.request("turn/start", params);
  }

  async steerTurn(params: CodexAppServerTurnSteerParams): Promise<unknown> {
    return this.request("turn/steer", params);
  }

  async interruptTurn(params: CodexAppServerTurnInterruptParams): Promise<unknown> {
    return this.request("turn/interrupt", params);
  }

  async archiveThread(threadId: string): Promise<unknown> {
    return this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<unknown> {
    return this.request("thread/unarchive", { threadId });
  }

  async compactThread(threadId: string): Promise<unknown> {
    return this.request("thread/compact/start", { threadId });
  }

  async request<T = unknown>(
    method: string,
    params: object | undefined,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<T> {
    this.start();
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }

    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params: params ?? {} });
    this.proc.stdin.write(line + "\n");

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    });
  }

  async stop(signal: NodeJS.Signals = "SIGTERM", forceKillMs = 3000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    if (this.closed) return;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
        resolve();
      }, forceKillMs);
      proc.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      try {
        proc.stdin.end();
      } catch {
        // Ignore cleanup races.
      }
      proc.kill(signal);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutTail += chunk;
    const lines = this.stdoutTail.split("\n");
    this.stdoutTail = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.emit("malformed", line, err);
        continue;
      }

      if (this.isResponse(msg)) {
        this.handleResponse(msg);
        continue;
      }

      if (this.isNotification(msg)) {
        this.emit("notification", { method: msg.method, params: msg.params });
        this.emit(msg.method, msg.params);
        continue;
      }

      this.emit("unknown", msg);
    }
  }

  private handleResponse(msg: WireResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this.emit("orphanResponse", msg);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(this.formatProtocolError(pending.method, msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private isResponse(value: unknown): value is WireResponse {
    return !!value
      && typeof value === "object"
      && typeof (value as { id?: unknown }).id === "number";
  }

  private isNotification(value: unknown): value is CodexAppServerNotification {
    return !!value
      && typeof value === "object"
      && typeof (value as { method?: unknown }).method === "string";
  }

  private formatProtocolError(method: string, error: unknown): string {
    if (error instanceof Error) return `${method}: ${error.message}`;
    if (typeof error === "string") return `${method}: ${error}`;
    try {
      return `${method}: ${JSON.stringify(error)}`;
    } catch {
      return `${method}: ${String(error)}`;
    }
  }
}
