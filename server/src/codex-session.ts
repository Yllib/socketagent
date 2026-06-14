/**
 * Codex backend mirroring claude-session.ts. Drives the OpenAI Codex CLI
 * (`codex exec --json`) as a subprocess under the user's ChatGPT subscription
 * (auth_mode: "chatgpt" in ~/.codex/auth.json — no API key required).
 *
 * What this implementation covers:
 *   - Subprocess lifecycle (spawn, JSONL parse, stderr capture, exit handling)
 *   - thread_id capture + resume across turns
 *   - Sandbox mode (read-only / workspace-write / bypass) controllable per turn
 *   - Translation of codex JSONL events → existing SocketAgent ServerMessage
 *
 * Intentionally not supported:
 *   - Questions / answers (no codex equivalent in --json mode)
 *   - Mid-turn message injection (codex runs prompt → completion atomically;
 *     to interrupt, kill the subprocess and start a new turn)
 *   - Plugin-provided MCP servers (Codex gets the SocketAgent app MCP bridge,
 *     but arbitrary plugin MCP injection is not wired here yet)
 *   - Fork / branch / rewind
 *   - Claude-style system prompt mutation; SocketAgent extra instructions are
 *     passed as native Codex developer instructions where supported.
 *   - Compaction / context-window tracking (no JSONL surface)
 *   - Thinking budget config (Codex exposes reasoning effort, wired below)
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

import { spawn, spawnSync, execFileSync, ChildProcess } from "child_process";
import { WebSocket } from "ws";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ServerMessage, Backend, SessionInfo, HistoryEntry, CodexDriver } from "./protocol";
import { SessionContext, SocketAgentPlugin } from "./plugin-api";
import {
  saveSession,
  getSession,
  appendHistory,
  appendSdkEvent,
  updateSessionActivity,
  updateSessionContextUsage,
  remapSession,
  readCodexRolloutContextUsage,
} from "./session-store";
import type { ClaudeSession } from "./claude-session";
import { AppToolContext, stopAppMonitor } from "./app-tool-handlers";
import { registerCodexAppMcp } from "./codex-app-mcp";
import {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexAppServerRequestResponder,
  CodexAppServerUserInput,
} from "./codex-app-server-client";
import { resolveCodexDriver } from "./server-settings";
import { listSkills, SkillEntry } from "./skills-manager";

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

type QueuedPrompt = {
  text: string;
  priority: "now" | "next" | "later";
  messageId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingAppServerSteer = QueuedPrompt & {
  uuid: string;
};

// ─── CodexSession ─────────────────────────────────────────────────────────

export class CodexSession {
  private sessionId: string | null = null; // SocketAgent session id (= codex thread_id)
  private threadId: string | null = null;  // codex thread_id (for resume)
  private proc: ChildProcess | null = null;
  private appServer: CodexAppServerClient | null = null;
  private appServerInitialized = false;
  private appServerMcpRegistration: ReturnType<typeof registerCodexAppMcp> | null = null;
  private activeAppServerTurnId: string | null = null;
  private appServerTurnSettler: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private appServerAgentText = new Map<string, string>();
  private appServerReasoningText = new Map<string, string>();
  private appServerToolOutput = new Map<string, string>();
  private appServerFileChangeDiff = new Map<string, string>();
  private appServerFileChangePaths = new Map<string, string[]>();
  private appServerSeenUserMessageItems = new Set<string>();
  private _isCompacting = false;
  private _compactBoundaryEmitted = false;
  private _isRunning = false;
  private _model: string | null = null;
  private _effort: "low" | "medium" | "high" | "max" = "high";
  private _sandbox: SandboxMode = "danger-full-access";
  private _approvalPolicy: CodexAppServerApprovalPolicy = "never";
  private _approvalsReviewer: CodexAppServerApprovalsReviewer = "user";
  private _permissionMode = "bypassPermissions";
  private _appendSystemPrompt = "";
  private _collaborationMode = "default";
  private _ttsEnabled = false;
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
  private _lastUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    contextWindow: number;
  } | null = null;
  private _fileChangeSnapshots = new Map<string, Map<string, string | null>>();
  private _queuedPrompts: QueuedPrompt[] = [];
  private _pendingAppServerSteers: PendingAppServerSteer[] = [];
  private clientSockets = new Set<WebSocket>();

  public onActivity?: () => void;
  public onMonitorOutput?: (text: string) => void;
  public replacesSessionId?: string;
  // Mirrors the cast-accessed private on ClaudeSession; used by index.ts to
  // tell us "this is a resume of session X" before runQuery is called.
  public _resumeSessionId?: string;

  constructor(
    private ws: WebSocket,
    private cwd: string,
    private _plugins: SocketAgentPlugin[] = [],
    private readonly codexDriver: CodexDriver = "exec",
  ) {
    this.attachWebSocket(ws);
  }

  // ─── Public API (subset of ClaudeSession) ────────────────────────────

  get isRunning(): boolean { return this._isRunning; }
  get isCompacting(): boolean { return this._isCompacting; }
  get driver(): CodexDriver { return this.codexDriver; }
  get permissionMode(): string | null {
    return this._permissionMode;
  }
  get sessionModel(): string | null { return this._model; }
  get lastUsage(): NonNullable<CodexSession["_lastUsage"]> | null { return this._lastUsage; }
  get activeBackgroundTasks(): Map<string, string> { return new Map(); }
  get lastPreview(): string { return ""; }
  getSessionId(): string | null { return this.sessionId; }
  getCwd(): string { return this.cwd; }
  getActiveToolCall(): { toolUseId: string; name: string } | null { return null; }
  getAccumulatedBashOutput(): string | null { return null; }
  setSandbox(mode: SandboxMode): void {
    this._sandbox = mode;
    this._permissionMode = mode === "read-only"
      ? "plan"
      : mode === "danger-full-access"
        ? "bypassPermissions"
        : "default";
  }

  /** Mirrors ClaudeSession.setModel — async to match signature. */
  async setModel(model?: string): Promise<void> {
    this._model = model ?? null;
  }

  /**
   * Maps SocketAgent permission modes onto Codex sandbox + approval policy.
   * Regular Yolo keeps approval callbacks enabled so SocketAgent can still
   * enforce protected-file rules while auto-approving everything else.
   */
  async setPermissionMode(mode: string, options: { recordHistory?: boolean } = {}): Promise<void> {
    const previousMode = this._permissionMode;
    this._permissionMode = mode;
    this._approvalsReviewer = "user";
    switch (mode) {
      case "plan":
        this._sandbox = "read-only";
        this._approvalPolicy = "untrusted";
        break;
      case "bypassPermissions":
        this._sandbox = "danger-full-access";
        this._approvalPolicy = "untrusted";
        break;
      case "superYolo":
        this._sandbox = "danger-full-access";
        this._approvalPolicy = "never";
        break;
      default:
        this._sandbox = "workspace-write";
        this._approvalPolicy = "untrusted";
        break;
    }
    this.persistPermissionMode();
    if (options.recordHistory !== false && previousMode !== this._permissionMode) {
      this.appendPermissionModeHistory();
    }
  }

  private persistPermissionMode(): void {
    if (!this.sessionId) return;
    const session = getSession(this.sessionId);
    if (!session) return;
    session.permissionMode = this._permissionMode;
    saveSession(session);
  }

  private appendPermissionModeHistory(): void {
    if (!this.sessionId) return;
    appendHistory(this.sessionId, {
      role: "permission_mode",
      content: "",
      permissionMode: this._permissionMode,
      timestamp: now(),
    });
  }

  setWebSocket(ws: WebSocket): void { this.attachWebSocket(ws); }
  replayLiveState(ws: WebSocket = this.ws): void {
    const sid = this.sessionId || "";
    if (!sid) return;

    for (const content of this.appServerReasoningText.values()) {
      if (content) {
        this.sendTo(ws, { type: "thinking", content, sessionId: sid } as ServerMessage);
      }
    }

    for (const content of this.appServerAgentText.values()) {
      if (content) {
        this.sendTo(ws, { type: "text", content, sessionId: sid } as ServerMessage);
      }
    }
  }
  detachWebSocket(): void {
    // Keep attached sockets until they close so a second resume cannot steal
    // the live stream from an existing app view. The app filters by sessionId.
  }

  // ─── Shims for ClaudeSession surface area ────────────────────────────
  // Some are meaningful for Codex, others remain no-ops where Codex has no
  // matching runtime control.
  setEffort(e: string): void {
    if (e === "low" || e === "medium" || e === "high" || e === "max") {
      this._effort = e;
    }
  }
  setThinking(_t: unknown): void {}
  setDisallowedTools(_t: string[]): void {}
  setAppendSystemPrompt(s: string): void { this._appendSystemPrompt = s; }
  setCodexCollaborationMode(mode: string): void {
    const trimmed = (mode || "default").trim();
    this._collaborationMode = trimmed || "default";
  }
  getCodexCollaborationMode(): string {
    return this._collaborationMode;
  }
  setForkSource(_id: string): void {}
  setResumeSessionAt(_uuid: string): void {}
  setTtsEnabled(b: boolean): void { this._ttsEnabled = b; }
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

  async forkAppServerThread(sourceThreadId: string): Promise<{ threadId: string }> {
    if (this.codexDriver !== "app-server") {
      throw new Error("Codex thread fork requires App Server mode");
    }
    await this.ensureAppServer();
    const forked = await this.appServer!.forkThread({
      ...this.buildAppServerThreadParams(),
      threadId: sourceThreadId,
    });
    const threadId = this.extractThreadId(forked);
    if (!threadId) throw new Error("codex app-server did not return a forked thread id");
    this.threadId = threadId;
    this.sessionId = threadId;
    this._sessionInfoSaved = true;
    return { threadId };
  }

  async compactAppServerThread(threadId = this.threadId || this.sessionId || this._resumeSessionId): Promise<void> {
    if (this.codexDriver !== "app-server") {
      throw new Error("Codex compaction requires App Server mode");
    }
    if (!threadId) throw new Error("No Codex thread id to compact");
    await this.ensureAppServer();
    this._isCompacting = true;
    this._compactBoundaryEmitted = false;
    this.send({ type: "compacting", active: true, sessionId: threadId } as any);
    await this.appServer!.compactThread(threadId);
  }

  async rollbackAppServerThread(numTurns: number, threadId = this.threadId || this.sessionId || this._resumeSessionId): Promise<void> {
    if (this.codexDriver !== "app-server") {
      throw new Error("Codex rollback requires App Server mode");
    }
    if (!threadId) throw new Error("No Codex thread id to roll back");
    if (!Number.isFinite(numTurns) || numTurns < 1) throw new Error("Rollback must drop at least one turn");
    await this.ensureAppServer();
    await this.appServer!.rollbackThread(threadId, Math.floor(numTurns));
  }

  async listCodexCollaborationModes(): Promise<Array<Record<string, unknown>>> {
    if (this.codexDriver !== "app-server") {
      return [{ id: "default", name: "Default" }];
    }
    await this.ensureAppServer();
    const result = await this.appServer!.listCollaborationModes();
    const rawModes = Array.isArray((result as any)?.modes)
      ? (result as any).modes
      : Array.isArray((result as any)?.data)
        ? (result as any).data
      : Array.isArray(result)
        ? result
        : [];
    const modes: Array<Record<string, unknown>> = rawModes
      .filter((mode: any) => mode && typeof mode === "object")
      .map((mode: any) => ({
        id: String(mode.id || mode.mode || mode.name || "default"),
        name: String(mode.name || mode.title || mode.id || "Default"),
        ...(mode.description ? { description: String(mode.description) } : {}),
      }))
      .filter((mode: Record<string, unknown>) => typeof mode.id === "string" && mode.id.length > 0);
    if (!modes.some((mode) => mode.id === "default")) {
      modes.unshift({ id: "default", name: "Default" });
    }
    return modes;
  }

  /**
   * Codex exec runs each turn atomically, so mid-turn messages are queued for a
   * follow-up turn. Codex app-server supports mid-turn `turn/steer`; those
   * messages resolve only once Codex echoes the steered userMessage item.
   */
  async injectMessage(text: string, priority: 'now' | 'next' | 'later' = 'now', messageId?: string): Promise<void> {
    if (!this._isRunning) {
      // Race: turn finished between the client deciding to queue and us
      // receiving the message. Just run it directly.
      void this.runQuery(text).catch((err) => {
        console.error(`[codex] direct-run injected message failed: ${err.message}`);
      });
      return;
    }

    if (this.codexDriver === "app-server" && this.threadId && this.activeAppServerTurnId) {
      try {
        await this.ensureAppServer();
        return new Promise<void>((resolve, reject) => {
          const pending: PendingAppServerSteer = {
            text,
            priority,
            messageId,
            resolve,
            reject,
            uuid: crypto.randomUUID(),
          };
          this._pendingAppServerSteers.push(pending);
          try {
            const turnId = this.activeAppServerTurnId!;
            console.log(`[codex app-server] steering message mid-turn (thread=${this.threadId}, turn=${turnId}, priority=${priority}, messageId=${messageId || ""})`);
            this.appServer!.steerTurn({
              threadId: this.threadId!,
              expectedTurnId: turnId,
              input: this.buildAppServerTurnInput(text),
            })
              .then(() => {
                console.log(`[codex app-server] turn/steer accepted (turn=${turnId}, messageId=${messageId || ""})`);
              })
              .catch((err: any) => {
                this.requeuePendingAppServerSteer(pending, `turn/steer failed: ${err?.message || String(err)}`);
              });
          } catch (err: any) {
            this.requeuePendingAppServerSteer(pending, `turn/steer failed: ${err?.message || String(err)}`);
          }
        });
      } catch (err: any) {
        console.warn(`[codex app-server] turn/steer failed; queueing follow-up: ${err?.message || String(err)}`);
      }
    }

    if (this.codexDriver === "app-server") {
      console.warn(`[codex app-server] no active turn for injection; queueing follow-up (thread=${this.threadId || ""}, turn=${this.activeAppServerTurnId || ""}, priority=${priority}, messageId=${messageId || ""})`);
    }
    return new Promise<void>((resolve, reject) => {
      this._queuedPrompts.push({ text, priority, messageId, resolve, reject });
    });
  }

  retractQueuedPrompt(messageId: string): string | null {
    if (!messageId) return null;
    const idx = this._queuedPrompts.findIndex((p) => p.messageId === messageId);
    if (idx < 0) return null;
    const [prompt] = this._queuedPrompts.splice(idx, 1);
    prompt.reject(new Error("Queued prompt retracted"));
    return prompt.text;
  }

  getSessionContext(): SessionContext {
    return {
      sessionId: this.sessionId ?? "",
      cwd: this.cwd,
      send: (msg: ServerMessage | Record<string, any>) => {
        this.send(this.withCodexProtectedPrompt(msg) as ServerMessage);
      },
      appendHistory: (entry: HistoryEntry) => {
        if (this.sessionId) appendHistory(this.sessionId, this.withCodexProtectedHistory(entry));
      },
      pendingQuestions: new Map(),
      questionCounter: { next: () => crypto.randomUUID() },
    };
  }

  private withCodexProtectedPrompt(msg: ServerMessage | Record<string, any>): ServerMessage | Record<string, any> {
    if ((msg as any).type !== "question" || !Array.isArray((msg as any).questions)) {
      return msg;
    }
    return {
      ...(msg as Record<string, any>),
      questions: (msg as any).questions.map((question: any) => ({
        ...question,
        question: this.codexProtectedPromptText(question?.question),
      })),
    };
  }

  private withCodexProtectedHistory(entry: HistoryEntry): HistoryEntry {
    if (entry.role !== "question" || !Array.isArray((entry as any).questions)) {
      return entry;
    }
    return {
      ...entry,
      questions: (entry as any).questions.map((question: any) => ({
        ...question,
        question: this.codexProtectedPromptText(question?.question),
      })),
    };
  }

  private codexProtectedPromptText(text: unknown): unknown {
    if (typeof text !== "string") return text;
    return text.replace(/^Claude wants to /, "Codex wants to ");
  }

  /** Mirrors ClaudeSession.send — sends a ServerMessage over the WS. */
  private attachWebSocket(ws: WebSocket): void {
    this.ws = ws;
    this.clientSockets.add(ws);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  public send(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const socket of [...this.clientSockets]) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        this.clientSockets.delete(socket);
      }
    }
  }

  /**
   * Run a single turn. New thread on first call, resume on subsequent.
   * The second parameter is used when a fresh WebSocket/process resumes an
   * existing SocketAgent/Codex thread.
   */
  async runQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    if (this.codexDriver === "app-server") {
      return this.runAppServerQuery(prompt, resumeSessionId);
    }

    if (this._isRunning) throw new Error("CodexSession already running a turn");
    this._isRunning = true;
    this.onActivity?.();
    this._abortRequested = false;
    this._stderrBuffer = [];
    this._fileChangeSnapshots.clear();
    this._currentPrompt = prompt;
    this._lastAssistantText = "";

    // Resume case: index.ts set _resumeSessionId before calling runQuery.
    // Adopt it as our SocketAgent sessionId so history writes target the
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
        this.onActivity?.();
        this.send({
          type: "error",
          message: `codex failed to launch: ${err.message}`,
        } as ServerMessage);
        settleReject(err);
      });

      this.proc!.on("exit", (code, signal) => {
        this._isRunning = false;
        this.onActivity?.();
        const stderr = this._stderrBuffer.join("");

        if (this._abortRequested || signal === "SIGTERM" || signal === "SIGINT") {
          this.clearQueuedPrompts("Codex turn interrupted");
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
          this.refreshRolloutContextUsage();
          const nextPrompt = this.dequeueNextPrompt();
          if (nextPrompt) {
            nextPrompt.resolve();
            this.runQuery(nextPrompt.text, this.sessionId ?? undefined)
              .then(settleResolve)
              .catch(settleReject);
            return;
          }
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

  private async runAppServerQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    if (this._isRunning) throw new Error("CodexSession already running a turn");
    this._isRunning = true;
    this.onActivity?.();
    this._abortRequested = false;
    this._currentPrompt = prompt;
    this._lastAssistantText = "";
    this.appServerAgentText.clear();
    this.appServerReasoningText.clear();
    this.appServerToolOutput.clear();

    const resumeTarget = resumeSessionId || this._resumeSessionId;
    if (!this.sessionId && resumeTarget) {
      this.sessionId = resumeTarget;
      this.threadId = resumeTarget;
      this._sessionInfoSaved = true;
    }

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

    await this.ensureAppServer();

    const completion = new Promise<void>((resolve, reject) => {
      this.appServerTurnSettler = { resolve, reject };
    });

    try {
      const threadConfig = this.buildAppServerThreadParams();
      if (this.threadId) {
        let resumed: unknown;
        try {
          resumed = await this.appServer!.resumeThread({
            ...threadConfig,
            threadId: this.threadId,
          });
        } catch (err: any) {
          if (!this.isArchivedAppServerError(err)) throw err;
          await this.appServer!.unarchiveThread(this.threadId);
          resumed = await this.appServer!.resumeThread({
            ...threadConfig,
            threadId: this.threadId,
          });
        }
        this.adoptAppServerThread(this.extractThreadId(resumed) || this.threadId);
      } else {
        const started = await this.appServer!.startThread(threadConfig);
        this.adoptAppServerThread(this.extractThreadId(started));
      }

      if (!this.threadId) throw new Error("codex app-server did not return a thread id");

      const collaborationMode = this.codexCollaborationMode();
      const turn = await this.appServer!.startTurn({
        threadId: this.threadId,
        cwd: this.cwd,
        input: this.buildAppServerTurnInput(prompt),
        ...(collaborationMode ? { collaborationMode } : {}),
      });
      this.activeAppServerTurnId = this.extractTurnId(turn) || this.activeAppServerTurnId;

      await completion;

      const nextPrompt = this._abortRequested ? null : this.dequeueNextPrompt();
      if (nextPrompt) {
        nextPrompt.resolve();
        this._isRunning = false;
        this.activeAppServerTurnId = null;
        this.appServerTurnSettler = null;
        await this.runAppServerQuery(nextPrompt.text, this.sessionId ?? undefined);
      }
    } catch (err: any) {
      this.send({
        type: "error",
        message: `codex app-server error: ${err?.message || String(err)}`,
      } as ServerMessage);
      throw err;
    } finally {
      this._isRunning = false;
      this.activeAppServerTurnId = null;
      this.appServerTurnSettler = null;
      this.onActivity?.();
    }
  }

  private async ensureAppServer(): Promise<void> {
    if (!this.appServer) {
      this.appServer = new CodexAppServerClient({
        cwd: this.cwd,
        env: process.env,
        requestTimeoutMs: 60_000,
        startupTimeoutMs: 30_000,
      });
      this.appServer.on("notification", (notification: CodexAppServerNotification) => {
        this.handleAppServerNotification(notification.method, notification.params);
        this.onActivity?.();
      });
      this.appServer.on("stderr", (chunk: string) => {
        this._stderrBuffer.push(chunk);
      });
      this.appServer.on("serverRequest", (
        request: { method?: string; params?: unknown },
        respond: CodexAppServerRequestResponder,
      ) => {
        void this.handleAppServerRequest(request, respond);
      });
      this.appServer.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (this._isRunning && !this._abortRequested) {
          this.appServerTurnSettler?.reject(new Error(`codex app-server exited code=${code} signal=${signal}`));
        }
      });
    }

    if (!this.appServerInitialized) {
      await this.appServer.initialize({
        clientInfo: {
          name: "socketagent",
          title: "SocketAgent",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.appServerInitialized = true;
    }
  }

  private buildAppServerThreadParams(): {
    cwd: string;
    sandbox: SandboxMode;
    approvalPolicy: CodexAppServerApprovalPolicy;
    approvalsReviewer: CodexAppServerApprovalsReviewer;
    model?: string;
    config: Record<string, unknown>;
    experimentalRawEvents: boolean;
    persistExtendedHistory: boolean;
  } {
    return {
      cwd: this.cwd,
      sandbox: this._sandbox,
      approvalPolicy: this._approvalPolicy,
      approvalsReviewer: this._approvalsReviewer,
      ...(this._model ? { model: this._model } : {}),
      config: this.appServerConfig(),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
  }

  private appServerConfig(): Record<string, unknown> {
    if (!this.appServerMcpRegistration) {
      this.appServerMcpRegistration = registerCodexAppMcp(this.createAppToolContext());
    }
    const mcpUrl = this.buildCodexMcpUrl(this.appServerMcpRegistration.token);
    return {
      model_reasoning_effort: this.codexReasoningEffort(),
      mcp_servers: {
        socketagent_app: {
          url: mcpUrl,
        },
      },
    };
  }

  private buildCodexTurnText(prompt: string): string {
    return prompt;
  }

  private buildAppServerTurnInput(prompt: string): CodexAppServerUserInput[] {
    const slashSkill = this.resolveCodexSlashSkill(prompt);
    if (!slashSkill) {
      return [{ type: "text", text: this.buildCodexTurnText(prompt), text_elements: [] }];
    }

    const text = slashSkill.args || `Use the /${slashSkill.skill.name} skill.`;
    return [
      {
        type: "skill",
        name: slashSkill.skill.name,
        path: slashSkill.skill.filePath,
      },
      {
        type: "text",
        text: this.buildCodexTurnText(text),
        text_elements: [],
      },
    ];
  }

  private resolveCodexSlashSkill(prompt: string): { skill: SkillEntry; args: string } | null {
    const match = prompt.match(/^\/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    const requestedName = (match[1] || match[2] || match[3]).toLowerCase();
    const skills = listSkills(this.cwd).filter((skill) =>
      skill.agent === "codex" &&
      skill.format === "skill" &&
      skill.name.toLowerCase() === requestedName
    );
    if (skills.length === 0) return null;

    const scopeRank: Record<string, number> = { project: 0, user: 1, plugin: 2 };
    skills.sort((a, b) => {
      const scopeCmp = (scopeRank[a.scope] ?? 99) - (scopeRank[b.scope] ?? 99);
      if (scopeCmp !== 0) return scopeCmp;
      return a.filePath.localeCompare(b.filePath);
    });

    return {
      skill: skills[0],
      args: (match[4] || "").trim(),
    };
  }

  private extractThreadId(value: unknown): string | null {
    const v = value as any;
    return v?.thread?.id || v?.threadId || null;
  }

  private extractTurnId(value: unknown): string | null {
    const v = value as any;
    return v?.turn?.id || v?.turnId || null;
  }

  private adoptAppServerThread(threadId: string | null): void {
    if (!threadId) return;
    this.threadId = threadId;
    const isFirstTime = !this.sessionId;
    this.sessionId = threadId;

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
        codexDriver: this.codexDriver,
        permissionMode: this.permissionMode || undefined,
      };
      if (this.replacesSessionId) {
        remapSession(this.replacesSessionId, this.sessionId);
        saveSession(info);
        this.replacesSessionId = undefined;
      } else {
        saveSession(info);
      }
      this._sessionInfoSaved = true;

      if (isFirstTime) {
        this.appendPermissionModeHistory();
        this.send({
          type: "session_created",
          sessionId: this.sessionId,
          cwd: this.cwd,
          title,
          backend: "codex",
          permissionMode: this.permissionMode,
        } as ServerMessage);
        this.send({
          type: "permission_mode_changed",
          permissionMode: this.permissionMode,
        } as any);
      }
    }

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
  }

  private createAppToolContext(): AppToolContext {
    return {
      getSessionId: () => this.sessionId || "",
      getCwd: () => this.cwd,
      getBackend: () => "codex",
      getCodexDriver: () => this.codexDriver,
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
    this.clearQueuedPrompts("Codex turn interrupted");
    this.clearPendingAppServerSteers("Codex turn interrupted");
    if (this.codexDriver === "app-server") {
      if (this.appServer && this.threadId && this.activeAppServerTurnId) {
        this.appServer.interruptTurn({
          threadId: this.threadId,
          turnId: this.activeAppServerTurnId,
        }).catch((err) => {
          console.warn(`[codex app-server] turn interrupt failed: ${err.message}`);
        });
      }
      this.appServerTurnSettler?.resolve();
      this.appServerTurnSettler = null;
      this._isRunning = false;
      this.onActivity?.();
      if (this.sessionId) {
        this.send({
          type: "result",
          content: "(interrupted)",
          sessionId: this.sessionId,
        } as ServerMessage);
      }
      return;
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      // Hard kill if it doesn't exit promptly.
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      }, 2000);
    }
  }

  private dequeueNextPrompt(): QueuedPrompt | null {
    if (this._queuedPrompts.length === 0) return null;
    const nowIdx = this._queuedPrompts.findIndex((p) => p.priority === "now");
    if (nowIdx >= 0) return this._queuedPrompts.splice(nowIdx, 1)[0];
    return this._queuedPrompts.shift() ?? null;
  }

  private clearQueuedPrompts(reason: string): void {
    const queued = this._queuedPrompts.splice(0);
    for (const prompt of queued) {
      prompt.reject(new Error(reason));
    }
  }

  private clearPendingAppServerSteers(reason: string): void {
    const pending = this._pendingAppServerSteers.splice(0);
    for (const steer of pending) {
      steer.reject(new Error(reason));
    }
  }

  private requeuePendingAppServerSteers(reason: string): void {
    const pending = [...this._pendingAppServerSteers];
    for (const steer of pending) {
      this.requeuePendingAppServerSteer(steer, reason);
    }
  }

  private requeuePendingAppServerSteer(steer: PendingAppServerSteer, reason: string): void {
    const idx = this._pendingAppServerSteers.indexOf(steer);
    if (idx < 0) {
      console.warn(`[codex app-server] ${reason} after userMessage dispatch`);
      return;
    }
    this._pendingAppServerSteers.splice(idx, 1);
    console.warn(`[codex app-server] ${reason}; queueing follow-up`);
    this._queuedPrompts.push({
      text: steer.text,
      priority: steer.priority,
      messageId: steer.messageId,
      resolve: steer.resolve,
      reject: steer.reject,
    });
    this.runQueuedPromptIfIdle();
  }

  private runQueuedPromptIfIdle(): void {
    if (this._isRunning || this._abortRequested) return;
    const nextPrompt = this.dequeueNextPrompt();
    if (!nextPrompt) return;
    nextPrompt.resolve();
    void this.runQuery(nextPrompt.text).catch((err) => nextPrompt.reject(err instanceof Error ? err : new Error(String(err))));
  }

  private acknowledgeNextAppServerSteer(): void {
    const pending = this._pendingAppServerSteers.shift();
    if (!pending) return;
    const sid = this.sessionId;
    if (sid) {
      appendHistory(sid, {
        role: "user",
        content: pending.text,
        uuid: pending.uuid,
        timestamp: now(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: pending.uuid,
        sessionId: sid,
      } as any);
    }
    pending.resolve();
  }

  private async handleAppServerRequest(
    request: { method?: string; params?: unknown },
    respond: CodexAppServerRequestResponder,
  ): Promise<void> {
    const method = request.method || "unknown";
    const params = (request.params || {}) as any;
    try {
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const command = String(params.command || "");
          const allowed = await this.canApproveAppServerTool("Bash", {
            command,
          });
          respond({ result: { decision: allowed ? "accept" : "decline" } });
          return;
        }

        case "execCommandApproval": {
          const command = Array.isArray(params.command)
            ? params.command.join(" ")
            : String(params.command || "");
          const allowed = await this.canApproveAppServerTool("Bash", {
            command,
          });
          respond({ result: { decision: allowed ? "approved" : "denied" } });
          return;
        }

        case "item/fileChange/requestApproval": {
          const allowed = await this.canApproveAppServerFileChange(params.itemId);
          respond({ result: { decision: allowed ? "accept" : "decline" } });
          return;
        }

        case "applyPatchApproval": {
          const allowed = await this.canApproveLegacyApplyPatch(params.fileChanges);
          respond({ result: { decision: allowed ? "approved" : "denied" } });
          return;
        }

        case "item/permissions/requestApproval": {
          const permissionsAllowed = await this.canApprovePermissionRequest(params.permissions);
          respond({
            result: {
              permissions: permissionsAllowed
                ? (params.permissions || {})
                : { network: null, fileSystem: null },
              scope: "turn",
              strictAutoReview: true,
            },
          });
          return;
        }

        default:
          console.warn(`[codex app-server] unsupported server request: ${method}`);
          respond({
            error: {
              code: "unsupported_server_request",
              message: `SocketAgent does not handle Codex app-server request '${method}' yet`,
            },
          });
      }
    } catch (err: any) {
      console.error(`[codex app-server] approval request failed: ${err?.message || String(err)}`);
      respond({
        error: {
          code: "socketagent_approval_error",
          message: err?.message || String(err),
        },
      });
    }
  }

  private async canApproveAppServerTool(
    toolName: string,
    input: Record<string, any>,
  ): Promise<boolean> {
    const sessionCtx = this.getSessionContext();
    for (const plugin of this._plugins) {
      if (!plugin.canUseToolInterceptor) continue;
      const result = await plugin.canUseToolInterceptor(toolName, input, sessionCtx);
      if (!result) continue;
      return result.behavior !== "deny";
    }
    return true;
  }

  private async canApproveAppServerFileChange(itemId: unknown): Promise<boolean> {
    if (!itemId) return true;
    const paths = this.appServerFileChangePaths.get(String(itemId)) || [];
    if (paths.length === 0) return true;
    for (const filePath of paths) {
      const allowed = await this.canApproveAppServerTool("Edit", {
        file_path: filePath,
      });
      if (!allowed) return false;
    }
    return true;
  }

  private async canApprovePermissionRequest(permissions: any): Promise<boolean> {
    const fileSystem = permissions?.fileSystem || null;
    const writePaths = [
      ...(Array.isArray(fileSystem?.write) ? fileSystem.write : []),
      ...(Array.isArray(fileSystem?.entries)
        ? fileSystem.entries
            .filter((entry: any) => entry?.access === "write" || entry?.writable === true)
            .map((entry: any) => entry?.path || entry?.root || entry?.glob)
        : []),
    ].filter(Boolean);
    for (const filePath of writePaths) {
      const allowed = await this.canApproveAppServerTool("Edit", {
        file_path: String(filePath),
      });
      if (!allowed) return false;
    }
    return true;
  }

  private async canApproveLegacyApplyPatch(fileChanges: unknown): Promise<boolean> {
    if (!fileChanges || typeof fileChanges !== "object") return true;
    for (const filePath of Object.keys(fileChanges as Record<string, unknown>)) {
      const allowed = await this.canApproveAppServerTool("Edit", {
        file_path: filePath,
      });
      if (!allowed) return false;
    }
    return true;
  }

  private handleAppServerNotification(method: string, params: unknown): void {
    const p = params as any;
    this.emitAppServerRawEvent(method, p);
    switch (method) {
      case "thread/started":
        this.adoptAppServerThread(p?.thread?.id || p?.threadId || null);
        return;

      case "turn/started":
        this.activeAppServerTurnId = p?.turn?.id || p?.turnId || this.activeAppServerTurnId;
        return;

      case "thread/status/changed": {
        const sid = this.sessionId;
        if (!sid) return;
        const statusType = p?.status?.type;
        if (statusType === "active") {
          this.send({ type: "session_state_changed", state: "running", sessionId: sid } as any);
        } else if (statusType === "idle") {
          this.send({ type: "session_state_changed", state: "idle", sessionId: sid } as any);
        } else if (statusType === "systemError") {
          this.send({ type: "session_state_changed", state: "idle", sessionId: sid } as any);
          this.send({ type: "error", message: "Codex app-server entered systemError state", sessionId: sid } as any);
        }
        return;
      }

      case "thread/compacted": {
        const sid = this.sessionId || p?.threadId;
        if (!sid) return;
        this._isCompacting = false;
        this.send({ type: "compacting", active: false, sessionId: sid } as any);
        this.emitCompactBoundary(sid, "manual");
        return;
      }

      case "thread/name/updated": {
        const sid = String(p?.threadId || this.sessionId || "");
        const title = String(p?.threadName || "").trim();
        if (!sid || !title) return;
        const session = getSession(sid);
        if (session) {
          session.title = title;
          session.lastActive = now();
          saveSession(session);
        }
        return;
      }

      case "item/agentMessage/delta": {
        const sid = this.sessionId;
        if (!sid) return;
        const itemId = p?.itemId || p?.item?.id || "agent";
        const delta = String(p?.delta ?? "");
        this.appServerAgentText.set(itemId, (this.appServerAgentText.get(itemId) || "") + delta);
        if (delta) {
          this.send({ type: "text", content: delta, sessionId: sid } as ServerMessage);
        }
        return;
      }

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const sid = this.sessionId;
        const itemId = p?.itemId || p?.item?.id || "reasoning";
        const delta = String(p?.delta ?? "");
        if (delta) this.appServerReasoningText.set(itemId, (this.appServerReasoningText.get(itemId) || "") + delta);
        if (sid && delta) this.send({ type: "thinking", content: delta, sessionId: sid } as ServerMessage);
        return;
      }

      case "hook/started": {
        const sid = this.sessionId;
        const run = p?.run || {};
        if (!sid) return;
        this.send({
          type: "hook_started",
          hookId: String(run.id || ""),
          hookName: this.formatAppServerHookName(run),
          hookEvent: String(run.eventName || ""),
          sessionId: sid,
        } as any);
        return;
      }

      case "hook/completed": {
        const sid = this.sessionId;
        const run = p?.run || {};
        if (!sid) return;
        const entries = Array.isArray(run.entries) ? run.entries : [];
        const stdout = entries.map((e: any) => e?.stdout || e?.output || "").filter(Boolean).join("\n");
        const stderr = entries.map((e: any) => e?.stderr || e?.error || "").filter(Boolean).join("\n");
        this.send({
          type: "hook_response",
          hookId: String(run.id || ""),
          hookName: this.formatAppServerHookName(run),
          hookEvent: String(run.eventName || ""),
          stdout,
          stderr,
          outcome: String(run.status || "completed"),
          sessionId: sid,
        } as any);
        return;
      }

      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta": {
        const sid = this.sessionId;
        if (!sid) return;
        const itemId = p?.itemId || p?.item?.id || p?.processId || p?.id;
        const delta = String(p?.delta ?? p?.chunk ?? "");
        if (!itemId || !delta) return;
        const key = String(itemId);
        this.appServerToolOutput.set(key, (this.appServerToolOutput.get(key) || "") + delta);
        this.send({
          type: "tool_result_chunk",
          toolUseId: key,
          content: delta,
          sessionId: sid,
          done: false,
          chunkIndex: 1,
        } as any);
        return;
      }

      case "item/commandExecution/terminalInteraction": {
        const sid = this.sessionId;
        const itemId = p?.itemId;
        const stdin = String(p?.stdin ?? "");
        if (!sid || !itemId || !stdin) return;
        const content = `[stdin] ${stdin}\n`;
        const key = String(itemId);
        this.appServerToolOutput.set(key, (this.appServerToolOutput.get(key) || "") + content);
        this.send({
          type: "tool_result_chunk",
          toolUseId: key,
          content,
          sessionId: sid,
          done: false,
          chunkIndex: 1,
        } as any);
        return;
      }

      case "thread/tokenUsage/updated": {
        const usage = this.usageFromAppServerTokenUsage(p?.tokenUsage);
        if (!usage || !this.sessionId) return;
        this._lastUsage = usage;
        this.send({
          type: "usage_update",
          sessionId: this.sessionId,
          ...usage,
        } as any);
        const contextUsage = this.contextUsageFromAppServerUsage(usage);
        if (contextUsage) {
          this.send({
            type: "context_usage",
            sessionId: this.sessionId,
            ...contextUsage,
          } as any);
          updateSessionContextUsage(this.sessionId, contextUsage);
        }
        updateSessionActivity(this.sessionId, this._lastAssistantText, usage);
        return;
      }

      case "turn/plan/updated": {
        const sid = this.sessionId || p?.threadId;
        if (!sid) return;
        const turnId = String(p?.turnId || "");
        const explanation = typeof p?.explanation === "string" ? p.explanation : "";
        const plan = Array.isArray(p?.plan) ? p.plan : [];
        this.send({
          type: "codex_plan",
          turnId,
          explanation,
          plan,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "codex_plan",
          content: explanation,
          toolUseId: turnId,
          toolInput: { explanation, steps: plan },
          timestamp: now(),
        } as HistoryEntry);
        return;
      }

      case "account/rateLimits/updated": {
        const sid = this.sessionId;
        const primary = p?.rateLimits?.primary;
        if (!sid || !primary) return;
        const utilization = Number(primary.usedPercent ?? 0);
        this.send({
          type: "rate_limit_event",
          status: utilization >= 100 ? "rejected" : utilization >= 85 ? "allowed_warning" : "allowed",
          utilization,
          resetsAt: primary.resetsAt ? new Date(Number(primary.resetsAt) * 1000).toISOString() : undefined,
          rateLimitType: p?.rateLimits?.limitName || p?.rateLimits?.limitId || undefined,
          sessionId: sid,
        } as any);
        return;
      }

      case "model/rerouted": {
        const sid = this.sessionId;
        if (!sid) return;
        const fromModel = String(p?.fromModel || "unknown");
        const toModel = String(p?.toModel || "unknown");
        this.send({
          type: "task_notification",
          taskId: String(p?.turnId || "model-rerouted"),
          status: "completed",
          summary: `Model rerouted: ${fromModel} -> ${toModel}`,
          sessionId: sid,
        } as any);
        return;
      }

      case "guardianWarning":
      case "deprecationNotice":
      case "windows/worldWritableWarning": {
        const message = String(p?.message || p?.warning || method);
        this.send({ type: "error", message } as ServerMessage);
        return;
      }

      case "mcpServer/startupStatus/updated": {
        const name = String(p?.name || "MCP server");
        const error = p?.error ? String(p.error) : "";
        if (error) {
          this.send({ type: "error", message: `${name}: ${error}` } as ServerMessage);
        }
        return;
      }

      case "item/fileChange/patchUpdated": {
        const itemId = p?.itemId;
        if (!itemId) return;
        this.appServerFileChangeDiff.set(String(itemId), this.formatAppServerFileChanges(p?.changes));
        return;
      }

      case "item/fileChange/outputDelta": {
        const itemId = p?.itemId;
        const delta = String(p?.delta ?? "");
        if (!itemId || !delta) return;
        const key = String(itemId);
        this.appServerFileChangeDiff.set(key, (this.appServerFileChangeDiff.get(key) || "") + delta);
        return;
      }

      case "turn/diff/updated":
        // Useful as a turn-level aggregate, but individual fileChange cards are
        // a better fit for the current chat UI. Keep this as a known no-op.
        return;

      case "item/mcpToolCall/progress": {
        const sid = this.sessionId;
        const itemId = p?.itemId;
        const message = String(p?.message ?? "");
        if (!sid || !itemId || !message) return;
        this.send({
          type: "tool_result_chunk",
          toolUseId: String(itemId),
          content: `${message}\n`,
          sessionId: sid,
          done: false,
          chunkIndex: 1,
        } as any);
        return;
      }

      case "item/started":
      case "item/completed":
        this.handleAppServerItem(method, p?.item, p);
        return;

      case "turn/completed": {
        const sid = this.sessionId;
        this.requeuePendingAppServerSteers("turn completed before steered userMessage was emitted");
        if (sid) {
          const usage = this._lastUsage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            contextWindow: 0,
          };
          this.send({
            type: "result",
            content: "",
            sessionId: sid,
            usage,
          } as ServerMessage);
          updateSessionActivity(sid, this._lastAssistantText, usage);
        }
        this.appServerTurnSettler?.resolve();
        return;
      }

      case "error":
      case "warning":
      case "configWarning":
        if (p?.message) {
          this.send({ type: "error", message: String(p.message) } as ServerMessage);
        }
        return;
    }
  }

  private handleAppServerItem(method: "item/started" | "item/completed", item: any, event?: any): void {
    const sid = this.sessionId;
    if (!sid || !item?.id || !item?.type) return;

    if (item.type === "userMessage") {
      if (!this.appServerSeenUserMessageItems.has(item.id)) {
        this.appServerSeenUserMessageItems.add(item.id);
        this.acknowledgeNextAppServerSteer();
      }
      return;
    }

    if (item.type === "agentMessage" && method === "item/completed") {
      const text = item.text || this.appServerAgentText.get(item.id) || "";
      if (text) {
        this._lastAssistantText = text;
        appendHistory(sid, {
          role: "assistant",
          content: text,
          timestamp: now(),
        });
      }
      this.appServerAgentText.delete(item.id);
      return;
    }

    if (item.type === "reasoning" && method === "item/completed") {
      const text = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ].join("\n");
      const streamed = this.appServerReasoningText.get(item.id) || "";
      if (text && !streamed) this.send({ type: "thinking", content: text, sessionId: sid } as ServerMessage);
      if (item.id) this.appServerReasoningText.delete(item.id);
      return;
    }

    if (item.type === "contextCompaction") {
      if (method === "item/started") {
        this._isCompacting = true;
        this._compactBoundaryEmitted = false;
        this.send({ type: "compacting", active: true, sessionId: sid } as any);
      } else {
        this._isCompacting = false;
        this.send({ type: "compacting", active: false, sessionId: sid } as any);
        this.emitCompactBoundary(sid, "manual");
      }
      return;
    }

    if (item.type === "commandExecution") {
      if (method === "item/started") {
        this.send({
          type: "tool_call",
          tool: "Bash",
          input: { command: item.command || "" },
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_call",
          content: item.command || "",
          toolName: "Bash",
          toolInput: { command: item.command || "" },
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const buffered = this.appServerToolOutput.get(item.id) || "";
        const baseOutput = item.aggregatedOutput ?? buffered;
        const suffix = item.exitCode ? `\n[exit ${item.exitCode}]` : "";
        const output = `${baseOutput || ""}${suffix}`;
        this.send({
          type: "tool_result_chunk",
          toolUseId: item.id,
          content: "",
          sessionId: sid,
          done: true,
          chunkIndex: 1,
        } as any);
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
        this.appServerToolOutput.delete(item.id);
      }
      return;
    }

    if (item.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes.map((c: any) => c?.path || c?.filePath).filter(Boolean);
      if (method === "item/started") {
        this.appServerFileChangePaths.set(item.id, files);
        this.send({
          type: "tool_call",
          tool: "ApplyPatch",
          input: {
            changes,
            files,
          },
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_call",
          content: this.summarizeAppServerFileChanges(changes),
          toolName: "ApplyPatch",
          toolInput: {
            changes,
            files,
          },
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const output = this.formatAppServerFileChanges(changes)
          || this.appServerFileChangeDiff.get(item.id)
          || "File changes applied";
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
        this.appServerFileChangeDiff.delete(item.id);
        this.appServerFileChangePaths.delete(item.id);
      }
      return;
    }

    if (item.type === "mcpToolCall") {
      const isSocketAgentApp = item.server === "socketagent_app" || item.server === "socketagent-app";
      const toolName = isSocketAgentApp ? item.tool : `mcp:${item.server}/${item.tool}`;
      if (method === "item/started") {
        const input = (item.arguments && typeof item.arguments === "object") ? item.arguments : {};
        this.send({
          type: "tool_call",
          tool: toolName,
          input,
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
      } else {
        const output = item.error
          ? `Error: ${JSON.stringify(item.error)}`
          : JSON.stringify(item.result ?? null, null, 2);
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        } as ServerMessage);
      }
      return;
    }

    if (item.type === "collabAgentToolCall") {
      const input = {
        description: item.prompt || `${item.tool || "Agent"} task`,
        prompt: item.prompt || "",
        subagent_type: item.tool || "agent",
        receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [],
        senderThreadId: item.senderThreadId || null,
        model: item.model || null,
        reasoningEffort: item.reasoningEffort || null,
      };
      if (method === "item/started") {
        this.send({
          type: "tool_call",
          tool: "Agent",
          input,
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_call",
          content: String(input.description || ""),
          toolName: "Agent",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const output = JSON.stringify({
          status: item.status || "completed",
          receiverThreadIds: item.receiverThreadIds || [],
          agentsStates: item.agentsStates || {},
        }, null, 2);
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        } as ServerMessage);
        this.send({
          type: "subagent_result",
          parentToolUseId: item.id,
          content: output,
          sessionId: sid,
        } as any);
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "dynamicToolCall") {
      const toolName = item.namespace ? `${item.namespace}/${item.tool || "tool"}` : (item.tool || "tool");
      if (method === "item/started") {
        const input = (item.arguments && typeof item.arguments === "object") ? item.arguments : {};
        this.send({
          type: "tool_call",
          tool: toolName,
          input,
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
      } else {
        const output = item.contentItems
          ? JSON.stringify(item.contentItems, null, 2)
          : item.success === false
            ? "Tool failed"
            : "Tool completed";
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        } as ServerMessage);
      }
      return;
    }

    if (item.type === "webSearch") {
      if (method === "item/started") {
        this.send({
          type: "tool_call",
          tool: "WebSearch",
          input: { query: item.query, action: item.action ?? null },
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
      } else {
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output: item.action ? JSON.stringify(item.action, null, 2) : "Search completed",
          sessionId: sid,
        } as ServerMessage);
      }
      return;
    }

    if (item.type === "imageView") {
      if (method === "item/started") {
        this.send({
          type: "tool_call",
          tool: "ViewImage",
          input: { path: item.path },
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
      } else {
        this.sendToolImageForPath(sid, item.id, item.path);
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output: item.path || "Image viewed",
          sessionId: sid,
        } as ServerMessage);
      }
      return;
    }

    if (item.type === "imageGeneration") {
      if (method === "item/started") {
        const input = {
          status: item.status,
          revisedPrompt: item.revisedPrompt ?? null,
        };
        this.send({
          type: "tool_call",
          tool: "ImageGeneration",
          input,
          toolUseId: item.id,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_call",
          content: "ImageGeneration",
          toolName: "ImageGeneration",
          toolInput: input,
          toolUseId: item.id,
          timestamp: now(),
        });
      } else {
        const generatedPath = this.appServerGeneratedImagePath(event?.threadId, item.id);
        const savedPath = item.savedPath || generatedPath || "";
        let sentImage = false;
        if (savedPath && fs.existsSync(savedPath)) sentImage = this.sendToolImageForPath(sid, item.id, savedPath);
        if (!sentImage) sentImage = this.sendToolImageFromBase64(sid, item.id, item.result, savedPath);
        const output = sentImage && savedPath ? savedPath : item.status || "Image generation completed";
        this.send({
          type: "tool_result",
          toolUseId: item.id,
          output,
          sessionId: sid,
        } as ServerMessage);
        appendHistory(sid, {
          role: "tool_result",
          content: output,
          toolUseId: item.id,
          toolOutput: output,
          timestamp: now(),
        });
      }
      return;
    }

    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      if (method === "item/completed") {
        this.send({
          type: "task_notification",
          taskId: item.id,
          status: "completed",
          summary: item.type === "enteredReviewMode"
            ? `Entered review mode: ${item.review || ""}`
            : `Exited review mode: ${item.review || ""}`,
          sessionId: sid,
        } as any);
      }
      return;
    }
  }

  private formatAppServerHookName(run: any): string {
    const event = String(run?.eventName || "Hook");
    const sourcePath = String(run?.sourcePath || "");
    const sourceName = sourcePath ? path.basename(sourcePath) : "";
    return [event, sourceName].filter(Boolean).join(" ");
  }

  private appServerGeneratedImagePath(threadId: unknown, itemId: unknown): string | null {
    const thread = String(threadId || this.threadId || "").trim();
    const item = String(itemId || "").trim();
    if (!thread || !item) return null;
    return path.join(os.homedir(), ".codex", "generated_images", thread, `${item}.png`);
  }

  private sendToolImageFromBase64(sessionId: string, toolUseId: string, raw: unknown, filePath: string): boolean {
    let imageData = typeof raw === "string" ? raw.trim() : "";
    if (!imageData) return false;
    const dataUrl = imageData.match(/^data:([^;,]+);base64,(.+)$/);
    const mimeType = dataUrl?.[1] || "image/png";
    if (dataUrl) imageData = dataUrl[2];
    if (!/^[A-Za-z0-9+/=\s]+$/.test(imageData)) return false;
    imageData = imageData.replace(/\s+/g, "");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(imageData, "base64");
    } catch {
      return false;
    }
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return false;
    if (filePath && !fs.existsSync(filePath)) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, bytes);
      } catch {
        filePath = "";
      }
    }
    this.send({
      type: "tool_image",
      toolUseId,
      imageData,
      mimeType,
      filePath,
      sessionId,
    } as any);
    appendHistory(sessionId, {
      role: "tool_image",
      content: "",
      toolUseId,
      filePath,
      mimeType,
      timestamp: now(),
    });
    return true;
  }

  private sendToolImageForPath(sessionId: string, toolUseId: string, filePath: string): boolean {
    if (!filePath) return false;
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return false;
    const mimeType = this.imageMimeType(resolved);
    if (!mimeType) return false;
    try {
      const imageData = fs.readFileSync(resolved).toString("base64");
      this.send({
        type: "tool_image",
        toolUseId,
        imageData,
        mimeType,
        filePath: resolved,
        sessionId,
      } as any);
      appendHistory(sessionId, {
        role: "tool_image",
        content: "",
        toolUseId,
        filePath: resolved,
        mimeType,
        timestamp: now(),
      });
      return true;
    } catch (err: any) {
      console.warn(`[codex app-server] failed to send tool image ${resolved}: ${err?.message || String(err)}`);
      return false;
    }
  }

  private imageMimeType(filePath: string): string | null {
    switch (path.extname(filePath).toLowerCase()) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".svg": return "image/svg+xml";
      default: return null;
    }
  }

  private summarizeAppServerFileChanges(changes: any[]): string {
    return changes
      .map((change) => {
        const path = change?.path || change?.filePath || "";
        const kind = this.appServerFileChangeKind(change?.kind || change?.type);
        return [kind, path].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("\n");
  }

  private formatAppServerFileChanges(changes: any): string {
    if (!Array.isArray(changes)) return "";
    const parts: string[] = [];
    for (const change of changes) {
      const path = change?.path || change?.filePath || "";
      const diff = typeof change?.diff === "string" ? change.diff.trimEnd() : "";
      if (!diff) continue;
      if (path && !diff.startsWith("--- ") && !diff.startsWith("diff --git ")) {
        parts.push(`--- ${path}\n+++ ${path}\n${diff}`);
      } else {
        parts.push(diff);
      }
    }
    return parts.join("\n");
  }

  private appServerFileChangeKind(kind: any): string {
    if (typeof kind === "string") return kind;
    if (kind && typeof kind === "object") {
      return String(kind.type || kind.kind || "change");
    }
    return "change";
  }

  private usageFromAppServerTokenUsage(tokenUsage: any): NonNullable<CodexSession["_lastUsage"]> | null {
    const last = tokenUsage?.last || tokenUsage?.total;
    if (!last) return null;
    const cached = Number(last.cachedInputTokens ?? 0);
    return {
      inputTokens: Math.max(0, Number(last.inputTokens ?? 0) - cached),
      outputTokens: Number(last.outputTokens ?? 0),
      cacheReadTokens: cached,
      cacheCreateTokens: 0,
      contextWindow: Number(tokenUsage?.modelContextWindow ?? 0),
    };
  }

  private isArchivedAppServerError(err: any): boolean {
    const message = String(err?.message || err || "");
    return message.includes(" is archived") || message.includes("unarchive it first");
  }

  private contextUsageFromAppServerUsage(usage: NonNullable<CodexSession["_lastUsage"]>): Record<string, unknown> | null {
    if (!usage.contextWindow) return null;
    const totalTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
    return {
      totalTokens,
      maxTokens: usage.contextWindow,
      remainingTokens: Math.max(0, usage.contextWindow - totalTokens),
      percentUsed: usage.contextWindow > 0 ? totalTokens / usage.contextWindow : 0,
      categories: [
        ...(usage.cacheReadTokens > 0 ? [{ name: "Cached", tokens: usage.cacheReadTokens, color: "#89B4FA" }] : []),
        ...(usage.cacheCreateTokens > 0 ? [{ name: "New cache", tokens: usage.cacheCreateTokens, color: "#A6E3A1" }] : []),
        ...(usage.inputTokens > 0 ? [{ name: "Uncached", tokens: usage.inputTokens, color: "#F9E2AF" }] : []),
      ],
    };
  }

  private currentContextTokenTotal(): number {
    const usage = this._lastUsage;
    if (!usage) return 0;
    return Math.max(0, usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens);
  }

  private emitCompactBoundary(sid: string, trigger: string): void {
    if (this._compactBoundaryEmitted) return;
    this._compactBoundaryEmitted = true;
    const preTokens = this.currentContextTokenTotal();
    this.send({
      type: "compact_boundary",
      trigger,
      preTokens,
      sessionId: sid,
    } as any);
    appendHistory(sid, {
      role: "assistant",
      content: `[compact_boundary:${preTokens}:${trigger}]`,
      timestamp: now(),
    });
  }

  private emitAppServerRawEvent(method: string, params: any): void {
    const sid = String(this.sessionId || params?.threadId || params?.thread?.id || "");
    const event = {
      type: "sdk_event",
      sdkType: "codex_app_server",
      method,
      params,
      sessionId: sid,
      ts: now(),
    };
    if (sid) {
      appendSdkEvent(sid, event);
    }
    this.send(event as any);
  }

  // ─── Event translation: codex JSONL → SocketAgent ServerMessage ─────

  private handleEvent(evt: CodexEvent): void {
    switch (evt.type) {
      case "thread.started": {
        // Adopt thread_id as our SocketAgent sessionId. On resume, this
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
            codexDriver: this.codexDriver,
            permissionMode: this.permissionMode || undefined,
          };
          if (this.replacesSessionId) {
            remapSession(this.replacesSessionId, this.sessionId);
            saveSession(info);
            this.replacesSessionId = undefined;
          } else {
            saveSession(info);
          }
          this._sessionInfoSaved = true;

          // Tell the client the real sessionId now that we have it.
          // Mirrors the Claude flow where the SDK's init message produces
          // a follow-up session_created with the real id.
          if (isFirstTime) {
            this.appendPermissionModeHistory();
            this.send({
              type: "session_created",
              sessionId: this.sessionId,
              cwd: this.cwd,
              title,
              backend: "codex",
              permissionMode: this.permissionMode,
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
        const contextUsage = readCodexRolloutContextUsage(sid);
        const usage = this.usageFromCodexEvent(evt.usage, contextUsage);
        this._lastUsage = usage;
        this.send({
          type: "result",
          content: "",
          sessionId: sid,
          usage,
        } as ServerMessage);
        if (contextUsage) {
          this.sendRolloutContextUsage(sid, contextUsage, usage);
        }
        // Update lastActive + messagePreview so the session list reflects
        // recent activity. Codex doesn't give us a cost number under
        // ChatGPT-sub billing, so leave costUsd undefined.
        updateSessionActivity(sid, this._lastAssistantText, usage);
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

  private usageFromCodexEvent(
    eventUsage: CodexUsage,
    contextUsage: ReturnType<typeof readCodexRolloutContextUsage>,
  ): NonNullable<CodexSession["_lastUsage"]> {
    const lastTokenUsage = contextUsage?.lastTokenUsage;
    const cachedInputTokens = lastTokenUsage?.cached_input_tokens ?? eventUsage.cached_input_tokens ?? 0;
    return {
      inputTokens: lastTokenUsage
        ? Math.max(0, lastTokenUsage.input_tokens - cachedInputTokens)
        : eventUsage.input_tokens,
      outputTokens: lastTokenUsage?.output_tokens ?? eventUsage.output_tokens,
      cacheReadTokens: cachedInputTokens,
      cacheCreateTokens: 0,
      contextWindow: contextUsage?.maxTokens ?? 0,
    };
  }

  private sendRolloutContextUsage(
    sid: string,
    contextUsage: NonNullable<ReturnType<typeof readCodexRolloutContextUsage>>,
    usage: NonNullable<CodexSession["_lastUsage"]>,
  ): void {
    this.send({
      type: "context_usage",
      sessionId: sid,
      ...contextUsage,
    } as any);
    this.send({
      type: "usage_update",
      sessionId: sid,
      ...usage,
    } as any);
    updateSessionContextUsage(sid, contextUsage);
  }

  private refreshRolloutContextUsage(): void {
    const sid = this.sessionId;
    if (!sid) return;
    const contextUsage = readCodexRolloutContextUsage(sid);
    if (!contextUsage) return;
    const cachedInputTokens = contextUsage.lastTokenUsage.cached_input_tokens;
    const usage = {
      inputTokens: Math.max(0, contextUsage.lastTokenUsage.input_tokens - cachedInputTokens),
      outputTokens: contextUsage.lastTokenUsage.output_tokens,
      cacheReadTokens: cachedInputTokens,
      cacheCreateTokens: 0,
      contextWindow: contextUsage.maxTokens,
    };
    this._lastUsage = usage;
    this.sendRolloutContextUsage(sid, contextUsage, usage);
    updateSessionActivity(sid, this._lastAssistantText, usage);
  }

  private snapshotFileChanges(item: Extract<CodexItem, { type: "file_change" }>): void {
    const snapshots = new Map<string, string | null>();
    for (const change of item.changes) {
      if (snapshots.has(change.path)) continue;
      snapshots.set(change.path, this.readTextSnapshot(change.path));
    }
    this._fileChangeSnapshots.set(item.id, snapshots);
  }

  private buildFileChangeDiff(item: Extract<CodexItem, { type: "file_change" }>): string {
    const snapshots = this._fileChangeSnapshots.get(item.id);
    this._fileChangeSnapshots.delete(item.id);

    const parts: string[] = [];
    for (const change of item.changes) {
      const before = snapshots?.has(change.path)
        ? snapshots.get(change.path)!
        : this.readTextSnapshot(change.path);
      const after = this.readTextSnapshot(change.path);
      const diff = this.unifiedDiff(change.path, before, after);
      parts.push(diff || `${change.kind}: ${change.path}`);
    }
    return this.truncateToolOutput(parts.join("\n\n"));
  }

  private resolveChangePath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);
  }

  private readTextSnapshot(filePath: string): string | null {
    const resolved = this.resolveChangePath(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return null;
      if (stat.size > 512 * 1024) return `[diff skipped: file larger than 512 KiB]`;
      const buf = fs.readFileSync(resolved);
      if (buf.includes(0)) return "[diff skipped: binary file]";
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  private unifiedDiff(filePath: string, before: string | null, after: string | null): string {
    if (before === after) return "";
    if (before?.startsWith("[diff skipped:") || after?.startsWith("[diff skipped:")) {
      return `${filePath}\n${before ?? after}`;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-codex-diff-"));
    const beforePath = path.join(tmpDir, "before");
    const afterPath = path.join(tmpDir, "after");
    try {
      fs.writeFileSync(beforePath, before ?? "", "utf8");
      fs.writeFileSync(afterPath, after ?? "", "utf8");
      try {
        return execFileSync(
          "diff",
          ["-u", "--label", `a/${filePath}`, "--label", `b/${filePath}`, beforePath, afterPath],
          { encoding: "utf8", maxBuffer: 1024 * 1024 },
        ).toString().trimEnd();
      } catch (err: any) {
        const stdout = err?.stdout ? String(err.stdout) : "";
        if (stdout) return stdout.trimEnd();
        return `${filePath}\n[diff unavailable]`;
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private truncateToolOutput(output: string): string {
    const max = 120 * 1024;
    if (output.length <= max) return output;
    return `${output.slice(0, max)}\n\n[diff truncated: ${output.length - max} additional chars]`;
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
          this.snapshotFileChanges(it);
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
          const summary = this.buildFileChangeDiff(it);
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
        const isSocketAgentApp =
          it.server === "socketagent_app" ||
          it.server === "socketagent-app" ||
          it.server === "\"socketagent-app\"";
        const toolName = isSocketAgentApp ? it.tool : `mcp:${it.server}/${it.tool}`;
        if (lifecycle === "item.started") {
          const input = (it.arguments as Record<string, unknown>) ?? {};
          this.send({
            type: "tool_call",
            tool: toolName,
            input,
            toolUseId: it.id,
            sessionId: sid,
          } as ServerMessage);
          if (!isSocketAgentApp) appendHistory(sid, {
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
          if (!isSocketAgentApp) appendHistory(sid, {
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
    return `mcp_servers.socketagent_app.url="${mcpUrl}"`;
  }

  private codexReasoningEffort(): "low" | "medium" | "high" {
    return this._effort === "max" ? "high" : this._effort;
  }

  private codexDeveloperInstructions(): string | null {
    const parts: string[] = [];

    if (this._ttsEnabled) {
      parts.push(
        "Text-to-speech is enabled. Before writing your final text response, call the Speak tool once with a concise, natural spoken summary. Keep it brief and conversational; do not read code, URLs, or markdown aloud. If your response is short and simple, speak it nearly verbatim. If it is long or technical, summarize the key points. Always still write your full text response after speaking.",
      );
    }

    const appendSystemPrompt = this._appendSystemPrompt.trim();
    if (appendSystemPrompt.length > 0) parts.push(appendSystemPrompt);

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  private codexCollaborationMode(): Record<string, unknown> | undefined {
    const developerInstructions = this.codexDeveloperInstructions();
    if (!developerInstructions && this._collaborationMode === "default") return undefined;
    return {
      mode: this._collaborationMode,
      ...(developerInstructions
        ? { settings: { developer_instructions: developerInstructions } }
        : {}),
    };
  }

  private codexDeveloperInstructionsConfigArg(): string | null {
    const developerInstructions = this.codexDeveloperInstructions();
    if (!developerInstructions) return null;
    return `developer_instructions=${JSON.stringify(developerInstructions)}`;
  }

  private buildExecArgs(mcpUrl: string): string[] {
    const args = [
      "exec",
      "--json",
      "-s", this._sandbox,
      "-C", this.cwd,
      "--skip-git-repo-check",
      "-c", this.codexMcpConfigArg(mcpUrl),
      "-c", `model_reasoning_effort="${this.codexReasoningEffort()}"`,
    ];
    const developerInstructionsArg = this.codexDeveloperInstructionsConfigArg();
    if (developerInstructionsArg) args.push("-c", developerInstructionsArg);
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
      "-c", `model_reasoning_effort="${this.codexReasoningEffort()}"`,
    ];
    const developerInstructionsArg = this.codexDeveloperInstructionsConfigArg();
    if (developerInstructionsArg) args.push("-c", developerInstructionsArg);
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
  plugins: SocketAgentPlugin[],
  codexDriver?: CodexDriver,
): Session {
  const enabled = getEnabledBackendSet();
  const requestedBackend = backend || (enabled.has("claude") ? "claude" : "codex");
  if (requestedBackend === "codex") {
    if (!enabled.has("codex")) {
      throw new Error("Codex backend is disabled on this server");
    }
    const availability = getCodexAvailability();
    if (!availability.available) {
      throw new Error(`Codex backend is not available on this server: ${availability.reason || "unknown reason"}`);
    }
    return new CodexSession(ws, cwd, plugins, resolveCodexDriver(codexDriver));
  }
  if (!enabled.has("claude")) {
    throw new Error("Claude backend is disabled on this server");
  }
  // Lazy require keeps the cycle (CodexSession → ClaudeSession via type-only
  // import) from blowing up at runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ClaudeSession: CS } = require("./claude-session") as typeof import("./claude-session");
  return new CS(ws, cwd, plugins);
}

async function withStandaloneAppServerClient<T>(
  cwd: string,
  fn: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const client = new CodexAppServerClient({
    cwd,
    env: process.env,
    requestTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
  });
  try {
    await client.initialize({
      clientInfo: {
        name: "socketagent",
        title: "SocketAgent",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    return await fn(client);
  } finally {
    await client.stop().catch(() => {});
  }
}

export async function archiveCodexAppServerThread(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.archiveThread(threadId);
  });
}

export async function unarchiveCodexAppServerThread(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.unarchiveThread(threadId);
  });
}

export async function compactCodexAppServerThread(threadId: string, cwd: string): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.compactThread(threadId);
  });
}

export async function rollbackCodexAppServerThread(threadId: string, cwd: string, numTurns: number): Promise<void> {
  await withStandaloneAppServerClient(cwd, async (client) => {
    await client.rollbackThread(threadId, numTurns);
  });
}

// ─── Backend availability detection ─────────────────────────────────────────

let _cachedBackends: Backend[] | null = null;
let _cachedCodexAvailability: { available: boolean; reason?: string } | null = null;

function getEnabledBackendSet(): Set<Backend> {
  const raw = (process.env.ENABLED_BACKENDS || "claude,codex").toLowerCase().trim();
  if (raw === "all" || raw === "both") return new Set<Backend>(["claude", "codex"]);

  const enabled = new Set<Backend>();
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name === "claude" || name === "anthropic") enabled.add("claude");
    if (name === "codex" || name === "openai") enabled.add("codex");
  }
  return enabled.size > 0 ? enabled : new Set<Backend>(["claude", "codex"]);
}

export function getCodexAvailability(): { available: boolean; reason?: string } {
  if (_cachedCodexAvailability) return _cachedCodexAvailability;
  try {
    const result = spawnSync("codex", ["--version"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      _cachedCodexAvailability = {
        available: false,
        reason: code === "ENOENT"
          ? "Codex CLI was not found on PATH"
          : `Codex CLI probe failed: ${result.error.message}`,
      };
      return _cachedCodexAvailability;
    }

    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      _cachedCodexAvailability = {
        available: false,
        reason: detail
          ? `Codex CLI probe exited ${result.status}: ${detail.slice(0, 300)}`
          : `Codex CLI probe exited ${result.status}`,
      };
      return _cachedCodexAvailability;
    }

    const home = process.env.HOME || os.homedir();
    if (!fs.existsSync(path.join(home, ".codex", "auth.json"))) {
      _cachedCodexAvailability = {
        available: false,
        reason: "Codex CLI is installed but ~/.codex/auth.json is missing",
      };
      return _cachedCodexAvailability;
    }

    _cachedCodexAvailability = { available: true };
    return _cachedCodexAvailability;
  } catch (e: any) {
    _cachedCodexAvailability = {
      available: false,
      reason: `Codex availability check failed: ${e?.message || String(e)}`,
    };
    return _cachedCodexAvailability;
  }
}

/**
 * Returns the list of agent backends this server can drive. Result is computed
 * once on first call and cached for the process lifetime — install/auth
 * changes require a server restart to take effect, which is acceptable.
 *
 * Claude is present when enabled (the Agent SDK ships with the server). Codex
 * is present iff enabled, the `codex` CLI is on PATH, and `~/.codex/auth.json`
 * exists.
 */
export function detectAvailableBackends(): Backend[] {
  if (_cachedBackends) return _cachedBackends;
  const enabled = getEnabledBackendSet();
  const list: Backend[] = [];
  if (enabled.has("claude")) list.push("claude");
  try {
    if (enabled.has("codex") && getCodexAvailability().available) list.push("codex");
  } catch (e: any) {
    console.error(`[codex] backend detection failed: ${e?.message || String(e)}`);
  }
  _cachedBackends = list;
  return list;
}
