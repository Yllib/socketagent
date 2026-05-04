/**
 * Codex backend mirroring claude-session.ts. Drives the OpenAI Codex CLI
 * (`codex exec --json`) as a subprocess under the user's ChatGPT subscription
 * (auth_mode: "chatgpt" in ~/.codex/auth.json — no API key required).
 *
 * What this implementation covers:
 *   - Subprocess lifecycle (spawn, JSONL parse, stderr capture, exit handling)
 *   - thread_id capture + resume across turns
 *   - Sandbox mode (read-only / workspace-write / bypass) controllable per turn
 *   - Translation of codex JSONL events → existing SocketClaude ServerMessage
 *
 * Intentionally not supported:
 *   - Questions / answers (no codex equivalent in --json mode)
 *   - Mid-turn message injection (codex runs prompt → completion atomically;
 *     to interrupt, kill the subprocess and start a new turn)
 *   - Plugin-provided MCP servers (Codex gets the SocketClaude app MCP bridge,
 *     but arbitrary plugin MCP injection is not wired here yet)
 *   - Fork / branch / rewind / clear_context
 *   - Append system prompt (codex uses AGENTS.md, not per-turn)
 *   - Compaction / context-window tracking (no JSONL surface)
 *   - Effort / thinking config (no codex flag)
 *
 * Empirical schema notes (from probes — see chat history):
 *   - resume does NOT accept -s or -C; only -c overrides + a few flags
 *   - resume does NOT inherit cwd from the original session — pass it via
 *     spawn options so codex picks it up from the parent process
 *   - file_change emits item.started + item.completed (not completed-only)
 *   - todo_list / apply_patch are NOT separate item types in --json mode
 *   - Sandbox denials don't fire structured events — model narrates them in
 *     an agent_message; cannot be detected programmatically
 *   - apply_patch verification retries leak only to stderr, not JSONL
 *   - Schema has had silent breaking renames historically
 *     (issue: openai/codex#4776) — keep the dispatcher tolerant of unknowns
 */

import { spawn, ChildProcess, execFileSync } from "child_process";
import { WebSocket } from "ws";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ServerMessage, Backend, SessionInfo, HistoryEntry } from "./protocol";
import { SessionContext, SocketClaudePlugin } from "./plugin-api";
import {
  saveSession,
  appendHistory,
  updateSessionActivity,
} from "./session-store";
import type { ClaudeSession } from "./claude-session";
import { AppToolContext, stopAppMonitor } from "./app-tool-handlers";
import { registerCodexAppMcp } from "./codex-app-mcp";

const now = (): string => new Date().toISOString();

// ─── Codex JSONL event types (from empirical probe) ───────────────────────

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

type CodexItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code: number | null;
      status: "in_progress" | "completed" | "failed";
    }
  | {
      id: string;
      type: "file_change";
      changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
      status: "in_progress" | "completed" | "failed";
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      arguments: unknown;
      result?: unknown;
      error?: string;
      status: "in_progress" | "completed" | "failed";
    }
  | { id: string; type: "web_search"; query: string }
  | { id: string; type: "error"; message: string }
  // Forward-compat catch-all so unknown future item types don't crash us.
  | { id: string; type: string;[k: string]: unknown };

type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "error"; message: string }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.updated"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem };

// ─── CodexSession ─────────────────────────────────────────────────────────

export class CodexSession {
  private sessionId: string | null = null; // SocketClaude session id (= codex thread_id)
  private threadId: string | null = null;  // codex thread_id (for resume)
  private proc: ChildProcess | null = null;
  private _isRunning = false;
  private _model: string | null = null;
  private _sandbox: SandboxMode = "danger-full-access";
  private _ttsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  private _kokoroVoice = "af_heart";
  private _kokoroSpeed = 1.0;
  private _stderrBuffer: string[] = [];
  private _abortRequested = false;
  // Persistence state — see runQuery/handleEvent for the buffer-then-flush
  // dance for the user prompt (prompt arrives before sessionId on first turn).
  private _sessionInfoSaved = false;
  private _pendingUserPrompt: { text: string; uuid: string } | null = null;
  private _currentPrompt = "";   // for SessionInfo.title on first save
  private _lastAssistantText = ""; // for messagePreview on turn.completed

  public onActivity?: () => void;
  public onMonitorOutput?: (text: string) => void;
  public replacesSessionId?: string;
  // Mirrors the cast-accessed private on ClaudeSession; used by index.ts to
  // tell us "this is a resume of session X" before runQuery is called.
  public _resumeSessionId?: string;

  constructor(
    private ws: WebSocket,
    private cwd: string,
    private _plugins: SocketClaudePlugin[] = [],
  ) {}

  // ─── Public API (subset of ClaudeSession) ────────────────────────────

  get isRunning(): boolean { return this._isRunning; }
  get isCompacting(): boolean { return false; }
  get permissionMode(): string | null {
    if (this._sandbox === "read-only") return "plan";
    if (this._sandbox === "danger-full-access") return "bypassPermissions";
    return "default";
  }
  get sessionModel(): string | null { return this._model; }
  get activeBackgroundTasks(): Map<string, string> { return new Map(); }
  get lastPreview(): string { return ""; }
  getSessionId(): string | null { return this.sessionId; }
  getCwd(): string { return this.cwd; }
  getActiveToolCall(): { toolUseId: string; name: string } | null { return null; }
  getAccumulatedBashOutput(): string | null { return null; }
  setSandbox(mode: SandboxMode): void { this._sandbox = mode; }

  /** Mirrors ClaudeSession.setModel — async to match signature. */
  async setModel(model?: string): Promise<void> {
    this._model = model ?? null;
  }

  /**
   * Maps SocketClaude permission modes onto codex sandbox modes:
   *   "plan"        → read-only
   *   "default"     → workspace-write
   *   "acceptEdits" → workspace-write (codex doesn't gate edits separately)
   *   "bypassPermissions" → danger-full-access
   */
  async setPermissionMode(mode: string): Promise<void> {
    switch (mode) {
      case "plan": this._sandbox = "read-only"; break;
      case "bypassPermissions": this._sandbox = "danger-full-access"; break;
      default: this._sandbox = "workspace-write"; break;
    }
  }

  setWebSocket(ws: WebSocket): void { this.ws = ws; }
  detachWebSocket(): void { /* WS reattach is per-message; nothing buffered. */ }

  // ─── No-op shims for ClaudeSession surface area ──────────────────────
  // Each is meaningful for Claude but has no codex-CLI equivalent.
  setEffort(_e: string): void {}
  setThinking(_t: unknown): void {}
  setDisallowedTools(_t: string[]): void {}
  setAppendSystemPrompt(_s: string): void {}
  setForkSource(_id: string): void {}
  setResumeSessionAt(_uuid: string): void {}
  setTtsEnabled(_b: boolean): void {}
  setTtsEngine(e: string): void {
    if (e === "system" || e === "kokoro_server" || e === "kokoro_device") {
      this._ttsEngine = e;
    }
  }
  setKokoroVoice(v: string): void { this._kokoroVoice = v; }
  setKokoroSpeed(s: number): void { this._kokoroSpeed = s; }
  resolveQuestion(_qid: string, _answers: Record<string, string>): boolean { return false; }
  submitAuthCode(_code: string): void {}
  interrupt(): void { this.abort(); }
  stopMonitoring(taskId: string): void {
    stopAppMonitor(taskId, true);
  }

  async stopTask(_taskId: string): Promise<void> {}
  async mcpServerStatus(): Promise<unknown[]> { return []; }
  async reconnectMcpServer(_name: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "MCP not supported on codex backend" };
  }
  async toggleMcpServer(_name: string, _enabled: boolean): Promise<void> {}
  async rewindFiles(_uuid: string, _dryRun = false): Promise<{ success: boolean; restored: string[] }> {
    return { success: false, restored: [] };
  }

  /**
   * Codex runs each turn atomically (prompt → completion via one `codex exec`
   * subprocess), so mid-turn injection isn't supported by SocketClaude.
   */
  async injectMessage(text: string, _priority: 'now' | 'next' | 'later' = 'now'): Promise<void> {
    if (!this._isRunning) {
      // Race: turn finished between the client deciding to queue and us
      // receiving the message. Just run it directly.
      void this.runQuery(text).catch((err) => {
        console.error(`[codex] direct-run injected message failed: ${err.message}`);
      });
      return;
    }
    throw new Error("Codex does not support sending another message while a query is running");
  }

  getSessionContext(): SessionContext {
    return {
      sessionId: this.sessionId ?? "",
      cwd: this.cwd,
      send: (msg: ServerMessage | Record<string, any>) => this.send(msg as ServerMessage),
      appendHistory: () => {},  // history persistence wired separately
      pendingQuestions: new Map(),
      questionCounter: { next: () => crypto.randomUUID() },
    };
  }

  /** Mirrors ClaudeSession.send — sends a ServerMessage over the WS. */
  public send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Run a single turn. New thread on first call, resume on subsequent.
   * The second parameter is used when a fresh WebSocket/process resumes an
   * existing SocketClaude/Codex thread.
   */
  async runQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    if (this._isRunning) throw new Error("CodexSession already running a turn");
    this._isRunning = true;
    this._abortRequested = false;
    this._stderrBuffer = [];
    this._currentPrompt = prompt;
    this._lastAssistantText = "";

    // Resume case: index.ts set _resumeSessionId before calling runQuery.
    // Adopt it as our SocketClaude sessionId so history writes target the
    // right file. (We confirm/replace it when thread.started fires.)
    const resumeTarget = resumeSessionId || this._resumeSessionId;
    if (!this.sessionId && resumeTarget) {
      this.sessionId = resumeTarget;
      this.threadId = resumeTarget;
      this._sessionInfoSaved = true;
    }

    // Log the user prompt now if we already know the sessionId; otherwise
    // buffer until thread.started arrives. Either way the app sees it via
    // the user_message_uuid below, which mirrors the Claude flow.
    const userMsgUuid = crypto.randomUUID();
    if (this.sessionId) {
      appendHistory(this.sessionId, {
        role: "user",
        content: prompt,
        uuid: userMsgUuid,
        timestamp: now(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: userMsgUuid,
        sessionId: this.sessionId,
      } as any);
    } else {
      this._pendingUserPrompt = { text: prompt, uuid: userMsgUuid };
    }

    const mcpRegistration = registerCodexAppMcp(this.createAppToolContext());
    const mcpUrl = this.buildCodexMcpUrl(mcpRegistration.token);
    const args = this.threadId
      ? this.buildResumeArgs(this.threadId, mcpUrl)
      : this.buildExecArgs(mcpUrl);

    this.proc = spawn("codex", args, {
      cwd: this.cwd, // resume relies on this — it does NOT inherit cwd from the original session
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdin?.on("error", (err) => {
      console.warn(`[codex] stdin error: ${err.message}`);
    });
    this.proc.stdin?.end(prompt);

    let stdoutTail = "";
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      stdoutTail += chunk;
      const lines = stdoutTail.split("\n");
      stdoutTail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as CodexEvent;
          this.handleEvent(evt);
          this.onActivity?.();
        } catch (err) {
          console.warn(`[codex] failed to parse JSONL line: ${line.slice(0, 200)}`);
        }
      }
    });

    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this._stderrBuffer.push(chunk);
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        mcpRegistration.unregister();
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        mcpRegistration.unregister();
        reject(err);
      };

      this.proc!.on("error", (err) => {
        // Spawn-level failure (e.g., codex binary missing). exit never fires
        // for this case, so surface it and settle the turn explicitly.
        console.error(`[codex] spawn error: ${err.message}`);
        this._isRunning = false;
        this.send({
          type: "error",
          message: `codex failed to launch: ${err.message}`,
        } as ServerMessage);
        settleReject(err);
      });

      this.proc!.on("exit", (code, signal) => {
        this._isRunning = false;
        const stderr = this._stderrBuffer.join("");

        if (this._abortRequested || signal === "SIGTERM" || signal === "SIGINT") {
          this.send({
            type: "result",
            content: "(interrupted)",
            sessionId: this.sessionId!,
          } as ServerMessage);
          // Don't drain queued prompts after a user-initiated abort.
          settleResolve();
          return;
        }

        if (code === 0) {
          settleResolve();
          return;
        }

        // Non-zero exit. Stderr likely contains the cause (auth failure,
        // network, codex crash). Tail to keep payload small.
        console.error(`[codex] exit ${code}: ${stderr.slice(-1500)}`);
        this.send({
          type: "error",
          message: `codex exec exit ${code}: ${stderr.slice(-1500)}`,
        } as ServerMessage);
        settleReject(new Error(`codex exec exit ${code}`));
      });
    });
  }

  private createAppToolContext(): AppToolContext {
    return {
      getSessionId: () => this.sessionId || "",
      getCwd: () => this.cwd,
      send: (msg) => this.send(msg as ServerMessage),
      appendHistory: (entry) => {
        if (this.sessionId) appendHistory(this.sessionId, entry as HistoryEntry);
      },
      getTtsEngine: () => this._ttsEngine,
      getKokoroVoice: () => this._kokoroVoice,
      getKokoroSpeed: () => this._kokoroSpeed,
      isRunning: () => this._isRunning,
      injectMessage: (text, priority) => this.injectMessage(text, priority),
      onMonitorOutput: (text) => this.onMonitorOutput?.(text),
    };
  }

  /** Mirrors the abort path. SIGTERM the subprocess; codex flushes pending events. */
  abort(): void {
    this._abortRequested = true;
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      // Hard kill if it doesn't exit promptly.
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      }, 2000);
    }
  }

  // ─── Event translation: codex JSONL → SocketClaude ServerMessage ─────

  private handleEvent(evt: CodexEvent): void {
    switch (evt.type) {
      case "thread.started": {
        // Adopt thread_id as our SocketClaude sessionId. On resume, this
        // should equal the value we already had; on a fresh session, it's
        // the first time we learn the id.
        this.threadId = evt.thread_id;
        const isFirstTime = !this.sessionId;
        this.sessionId = evt.thread_id;

        if (!this._sessionInfoSaved) {
          const title =
            this._currentPrompt.slice(0, 50) +
            (this._currentPrompt.length > 50 ? "..." : "");
          const info: SessionInfo = {
            id: this.sessionId,
            title,
            cwd: this.cwd,
            createdAt: now(),
            lastActive: now(),
            messagePreview: "",
            backend: "codex",
          };
          saveSession(info);
          this._sessionInfoSaved = true;

          // Tell the client the real sessionId now that we have it.
          // Mirrors the Claude flow where the SDK's init message produces
          // a follow-up session_created with the real id.
          if (isFirstTime) {
            this.send({
              type: "session_created",
              sessionId: this.sessionId,
              cwd: this.cwd,
              title,
              backend: "codex",
            } as ServerMessage);
            this.send({
              type: "permission_mode_changed",
              permissionMode: this.permissionMode,
            } as any);
          }
        }

        // Flush any user prompt that was buffered while sessionId was unknown.
        if (this._pendingUserPrompt) {
          appendHistory(this.sessionId, {
            role: "user",
            content: this._pendingUserPrompt.text,
            uuid: this._pendingUserPrompt.uuid,
            timestamp: now(),
          });
          this.send({
            type: "user_message_uuid",
            uuid: this._pendingUserPrompt.uuid,
            sessionId: this.sessionId,
          } as any);
          this._pendingUserPrompt = null;
        }
        return;
      }

      case "turn.started":
        return;

      case "turn.completed": {
        const sid = this.sessionId!;
        this.send({
          type: "result",
          content: "",
          sessionId: sid,
          usage: {
            inputTokens: evt.usage.input_tokens,
            outputTokens: evt.usage.output_tokens,
            cacheReadTokens: evt.usage.cached_input_tokens ?? 0,
            cacheCreateTokens: 0,
            contextWindow: 0,
          },
        } as ServerMessage);
        // Update lastActive + messagePreview so the session list reflects
        // recent activity. Codex doesn't give us a cost number under
        // ChatGPT-sub billing, so leave costUsd undefined.
        updateSessionActivity(sid, this._lastAssistantText, {
          inputTokens: evt.usage.input_tokens,
          outputTokens: evt.usage.output_tokens,
          cacheReadTokens: evt.usage.cached_input_tokens ?? 0,
          cacheCreateTokens: 0,
          contextWindow: 0,
        });
        return;
      }

      case "turn.failed":
        this.send({
          type: "error",
          message: `Turn failed: ${evt.error.message}`,
        } as ServerMessage);
        return;

      case "error":
        this.send({ type: "error", message: evt.message } as ServerMessage);
        return;

      case "item.started":
      case "item.updated":
      case "item.completed":
        this.handleItem(evt.type, evt.item);
        return;
    }
  }

  private handleItem(
    lifecycle: "item.started" | "item.updated" | "item.completed",
    item: CodexItem,
  ): void {
    const sid = this.sessionId!;

    switch (item.type) {
      case "agent_message":
        if (lifecycle === "item.completed") {
          const text = (item as { text: string }).text;
          this._lastAssistantText = text;
          this.send({
            type: "text",
            content: text,
            sessionId: sid,
          } as ServerMessage);
          appendHistory(sid, {
            role: "assistant",
            content: text,
            timestamp: now(),
          });
        }
        return;

      case "reasoning":
        if (lifecycle === "item.completed") {
          this.send({
            type: "thinking",
            content: (item as { text: string }).text,
            sessionId: sid,
          } as ServerMessage);
        }
        return;

      case "command_execution": {
        const it = item as Extract<CodexItem, { type: "command_execution" }>;
        if (lifecycle === "item.started") {
          this.send({
            type: "tool_call",
            tool: "Bash",
            input: { command: it.command },
            toolUseId: it.id,
            sessionId: sid,
          } as ServerMessage);
          appendHistory(sid, {
            role: "tool_call",
            content: it.command,
            toolName: "Bash",
            toolInput: { command: it.command },
            toolUseId: it.id,
            timestamp: now(),
          });
        } else if (lifecycle === "item.completed") {
          const suffix = it.exit_code !== 0 ? `\n[exit ${it.exit_code}]` : "";
          const output = it.aggregated_output + suffix;
          this.send({
            type: "tool_result",
            toolUseId: it.id,
            output,
            sessionId: sid,
          } as ServerMessage);
          appendHistory(sid, {
            role: "tool_result",
            content: output,
            toolUseId: it.id,
            toolOutput: output,
            timestamp: now(),
          });
        }
        return;
      }

      case "file_change": {
        const it = item as Extract<CodexItem, { type: "file_change" }>;
        if (lifecycle === "item.started") {
          this.send({
            type: "tool_call",
            tool: "ApplyPatch",
            input: { changes: it.changes },
            toolUseId: it.id,
            sessionId: sid,
          } as ServerMessage);
          appendHistory(sid, {
            role: "tool_call",
            content: it.changes.map((c) => `${c.kind}: ${c.path}`).join("\n"),
            toolName: "ApplyPatch",
            toolInput: { changes: it.changes },
            toolUseId: it.id,
            timestamp: now(),
          });
        } else if (lifecycle === "item.completed") {
          const summary = it.changes.map((c) => `${c.kind}: ${c.path}`).join("\n");
          this.send({
            type: "tool_result",
            toolUseId: it.id,
            output: summary,
            sessionId: sid,
          } as ServerMessage);
          appendHistory(sid, {
            role: "tool_result",
            content: summary,
            toolUseId: it.id,
            toolOutput: summary,
            timestamp: now(),
          });
        }
        return;
      }

      case "mcp_tool_call": {
        const it = item as Extract<CodexItem, { type: "mcp_tool_call" }>;
        const isSocketClaudeApp =
          it.server === "socketclaude_app" ||
          it.server === "socketclaude-app" ||
          it.server === "\"socketclaude-app\"";
        const toolName = isSocketClaudeApp ? it.tool : `mcp:${it.server}/${it.tool}`;
        if (lifecycle === "item.started") {
          const input = (it.arguments as Record<string, unknown>) ?? {};
          this.send({
            type: "tool_call",
            tool: toolName,
            input,
            toolUseId: it.id,
            sessionId: sid,
          } as ServerMessage);
          if (!isSocketClaudeApp) appendHistory(sid, {
            role: "tool_call",
            content: JSON.stringify(input),
            toolName,
            toolInput: input,
            toolUseId: it.id,
            timestamp: now(),
          });
        } else if (lifecycle === "item.completed") {
          const output = it.error
            ? `Error: ${it.error}`
            : JSON.stringify(it.result ?? null, null, 2);
          this.send({
            type: "tool_result",
            toolUseId: it.id,
            output,
            sessionId: sid,
          } as ServerMessage);
          if (!isSocketClaudeApp) appendHistory(sid, {
            role: "tool_result",
            content: output,
            toolUseId: it.id,
            toolOutput: output,
            timestamp: now(),
          });
        }
        return;
      }

      case "web_search": {
        const it = item as Extract<CodexItem, { type: "web_search" }>;
        if (lifecycle === "item.completed") {
          this.send({
            type: "tool_call",
            tool: "WebSearch",
            input: { query: it.query },
            toolUseId: it.id,
            sessionId: sid,
          } as ServerMessage);
          appendHistory(sid, {
            role: "tool_call",
            content: it.query,
            toolName: "WebSearch",
            toolInput: { query: it.query },
            toolUseId: it.id,
            timestamp: now(),
          });
        }
        return;
      }

      case "error": {
        const it = item as Extract<CodexItem, { type: "error" }>;
        if (lifecycle === "item.completed") {
          this.send({ type: "error", message: it.message } as ServerMessage);
        }
        return;
      }

      default:
        // Forward-compat: log unknown item types instead of crashing.
        // Schema has had silent renames historically.
        if (lifecycle === "item.completed") {
          console.log(`[codex] unknown item type: ${item.type}`, item);
        }
        return;
    }
  }

  // ─── codex CLI argument builders ─────────────────────────────────────

  private buildCodexMcpUrl(token: string): string {
    const port = process.env.PORT || "8085";
    return `http://127.0.0.1:${port}/codex-mcp/${encodeURIComponent(token)}`;
  }

  private codexMcpConfigArg(mcpUrl: string): string {
    return `mcp_servers.socketclaude_app.url="${mcpUrl}"`;
  }

  private buildExecArgs(mcpUrl: string): string[] {
    const args = [
      "exec",
      "--json",
      "-s", this._sandbox,
      "-C", this.cwd,
      "--skip-git-repo-check",
      "-c", this.codexMcpConfigArg(mcpUrl),
    ];
    if (this._model) args.push("-m", this._model);
    args.push("-");
    return args;
  }

  private buildResumeArgs(threadId: string, mcpUrl: string): string[] {
    // resume rejects -s and -C as flags. Sandbox is set via -c override.
    // cwd is picked up from the spawn cwd option, NOT inherited from session.
    // Verified: `-c sandbox_mode="<mode>"` overrides the default read-only on
    // resume (TOML quoting required — the inner quotes go in the argv literal).
    const args = [
      "exec", "resume", threadId,
      "--json",
      "--skip-git-repo-check",
      "-c", `sandbox_mode="${this._sandbox}"`,
      "-c", this.codexMcpConfigArg(mcpUrl),
    ];
    if (this._model) args.push("-m", this._model);
    args.push("-");
    return args;
  }
}

// ─── Backend factory ────────────────────────────────────────────────────────

/**
 * Union of the two session implementations. Most callers can treat them
 * interchangeably because CodexSession exposes shims for the ClaudeSession
 * methods it doesn't implement. Reach for `instanceof` only when a code path
 * needs a feature one backend doesn't support (e.g., MCP tools, fork, rewind).
 */
export type Session = ClaudeSession | CodexSession;

/**
 * Picks the right session implementation. The codex import is dynamic so the
 * Claude path doesn't pay the cost of loading codex types if it's never used.
 */
export function createSession(
  backend: Backend | undefined,
  ws: WebSocket,
  cwd: string,
  plugins: SocketClaudePlugin[],
): Session {
  if (backend === "codex") {
    if (!detectAvailableBackends().includes("codex")) {
      throw new Error("Codex backend is not available on this server. Install and authenticate the Codex CLI first.");
    }
    return new CodexSession(ws, cwd, plugins);
  }
  // Lazy require keeps the cycle (CodexSession → ClaudeSession via type-only
  // import) from blowing up at runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ClaudeSession: CS } = require("./claude-session") as typeof import("./claude-session");
  return new CS(ws, cwd, plugins);
}

// ─── Backend availability detection ─────────────────────────────────────────

let _cachedBackends: Backend[] | null = null;

function probeCodexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { timeout: 3000, stdio: "ignore" });
  } catch {
    return false;
  }
  const home = process.env.HOME || os.homedir();
  return fs.existsSync(path.join(home, ".codex", "auth.json"));
}

/**
 * Returns the list of agent backends this server can drive. Result is computed
 * once on first call and cached for the process lifetime — install/auth
 * changes require a server restart to take effect, which is acceptable.
 *
 * Claude is always present (the Agent SDK ships with the server). Codex is
 * present iff the `codex` CLI is on PATH AND `~/.codex/auth.json` exists.
 */
export function detectAvailableBackends(): Backend[] {
  if (_cachedBackends) return _cachedBackends;
  const list: Backend[] = ["claude"];
  if (probeCodexAvailable()) list.push("codex");
  _cachedBackends = list;
  return list;
}
