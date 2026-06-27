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
import { registerCodexAppMcp, SOCKETAGENT_APP_TOOLS } from "./codex-app-mcp";
import { SOCKETAGENT_FILE_LINK_INSTRUCTIONS } from "./socketagent-instructions";
import {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexAppServerRequestResponder,
  CodexAppServerUserInput,
} from "./codex-app-server-client";
import { buildCodexSpawn } from "./codex-env";
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
  fastMode?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingAppServerSteer = QueuedPrompt & {
  uuid: string;
};

export type CodexSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  availability?: "app-server" | "any";
};

type CodexRunOptions = {
  fastMode?: boolean;
  messageId?: string;
};

export const CODEX_NATIVE_SLASH_COMMANDS: CodexSlashCommand[] = [
  {
    name: "status",
    description: "Show Codex session status.",
    availability: "any",
  },
  {
    name: "compact",
    description: "Compact the current Codex thread.",
    availability: "app-server",
  },
  {
    name: "goal",
    description: "View, set, pause, resume, or clear the current goal.",
    argumentHint: "[text|pause|resume|clear]",
    availability: "app-server",
  },
  {
    name: "review",
    description: "Review uncommitted changes, or review with custom instructions.",
    argumentHint: "[instructions]",
    availability: "app-server",
  },
  {
    name: "mcp",
    description: "Show configured Codex MCP server status.",
    availability: "app-server",
  },
  {
    name: "model",
    description: "Show available models or set the active model.",
    argumentHint: "[model]",
    availability: "app-server",
  },
  {
    name: "permissions",
    description: "Show or set Codex permission mode.",
    argumentHint: "[ask|yolo|super-yolo|read-only]",
    availability: "any",
  },
  {
    name: "archive",
    description: "Archive the current Codex thread.",
    availability: "app-server",
  },
  {
    name: "fork",
    description: "Fork the current Codex thread.",
    availability: "app-server",
  },
];

// ─── CodexSession ─────────────────────────────────────────────────────────

export class CodexSession {
  private sessionId: string | null = null; // SocketAgent session id (= codex thread_id)
  private threadId: string | null = null;  // codex thread_id (for resume)
  private proc: ChildProcess | null = null;
  private appServer: CodexAppServerClient | null = null;
  private appServerInitialized = false;
  private appServerInitializePromise: Promise<void> | null = null;
  private appServerIdleStopTimer: ReturnType<typeof setTimeout> | null = null;
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
  private _compactBoundaryTrigger: "auto" | "manual" = "auto";
  private _isRunning = false;
  private _model: string | null = null;
  private _effort: "minimal" | "low" | "medium" | "high" | "max" | "xhigh" = "high";
  private _fastMode = false;
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
  private _pendingUserPrompt: { text: string; uuid: string; messageId?: string } | null = null;
  private _currentClientMessageId: string | null = null;
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
  get isBusy(): boolean {
    return this._isRunning
      || this._isCompacting
      || this.appServerTurnSettler !== null
      || this._pendingUserPrompt !== null
      || this._queuedPrompts.length > 0
      || this._pendingAppServerSteers.length > 0;
  }
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

    for (const [streamId, content] of this.appServerAgentText.entries()) {
      if (content) {
        this.sendTo(ws, { type: "text", content, sessionId: sid, streamId } as ServerMessage);
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
    if (e === "minimal" || e === "low" || e === "medium" || e === "high" || e === "max" || e === "xhigh") {
      this._effort = e;
    }
  }
  setCodexFastMode(enabled: boolean): void { this._fastMode = enabled; }
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
    this._compactBoundaryTrigger = "manual";
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

  async executeCodexSlashCommand(name: string, args = ""): Promise<void> {
    const command = name.trim().replace(/^\//, "").toLowerCase();
    const commandArgs = args.trim();
    const threadId = this.threadId || this.sessionId || this._resumeSessionId || "";
    const commandDef = CODEX_NATIVE_SLASH_COMMANDS.find((candidate) => candidate.name === command);
    if (!commandDef) {
      throw new Error(`Unsupported Codex slash command: /${command}`);
    }
    if (commandDef.availability === "app-server" && this.codexDriver !== "app-server") {
      throw new Error(`/${command} requires Codex App Server mode`);
    }

    switch (command) {
      case "status": {
        const result = await this.buildStatusResult(threadId);
        this.emitSlashCommandResult(command, result.summary, "completed", result.payload);
        return;
      }

      case "compact": {
        await this.compactAppServerThread(threadId);
        this.emitSlashCommandResult(command, "Codex thread compaction started.");
        return;
      }

      case "goal": {
        if (!threadId) throw new Error("No Codex thread id for /goal");
        await this.ensureAppServer();
        if (!commandArgs) {
          const result = await this.appServer!.getGoal(threadId);
          const goal = (result as any)?.goal;
          this.emitSlashCommandResult(
            command,
            goal
              ? `Goal: ${goal.objective || ""}\nStatus: ${goal.status || "unknown"}`
              : "No active goal.",
          );
          return;
        }
        const action = commandArgs.toLowerCase();
        if (action === "clear") {
          await this.appServer!.clearGoal(threadId);
          this.emitSlashCommandResult(command, "Goal cleared.");
          return;
        }
        if (action === "pause" || action === "paused") {
          await this.appServer!.setGoal(threadId, { status: "paused" });
          this.emitSlashCommandResult(command, "Goal paused.");
          return;
        }
        if (action === "resume" || action === "active") {
          await this.appServer!.setGoal(threadId, { status: "active" });
          this.emitSlashCommandResult(command, "Goal resumed.");
          return;
        }
        await this.appServer!.setGoal(threadId, { objective: commandArgs, status: "active" });
        this.emitSlashCommandResult(command, `Goal set: ${commandArgs}`);
        return;
      }

      case "review": {
        if (!threadId) throw new Error("No Codex thread id for /review");
        await this.ensureAppServer();
        await this.appServer!.startReview(threadId, commandArgs);
        this.emitSlashCommandResult(command, "Codex review started.");
        return;
      }

      case "mcp": {
        await this.ensureAppServer();
        this.appServerConfig();
        const result = await this.appServer!.listMcpServerStatus(undefined);
        const servers = Array.isArray((result as any)?.data) ? (result as any).data : [];
        const displayServers = servers.map((server: any) => ({
          name: String(server.name || server.serverName || "unnamed"),
          authStatus: this.formatMcpAuthStatus(server.authStatus || server.status || server.startupStatus || server.state || "unknown"),
          toolCount: server.tools && typeof server.tools === "object" ? Object.keys(server.tools).length : 0,
          resourceCount: Array.isArray(server.resources) ? server.resources.length : 0,
          templateCount: Array.isArray(server.resourceTemplates) ? server.resourceTemplates.length : 0,
          tools: server.tools && typeof server.tools === "object" ? Object.keys(server.tools) : [],
        }));
        if (!displayServers.some((server: any) => server.name === "socketagent_app")) {
          displayServers.unshift({
            name: "socketagent_app",
            authStatus: this.appServerMcpRegistration ? "registered" : "configured",
            toolCount: SOCKETAGENT_APP_TOOLS.length,
            resourceCount: 0,
            templateCount: 0,
            tools: SOCKETAGENT_APP_TOOLS.map((tool) => tool.name),
          });
        }
        const summary = displayServers.length === 0
          ? "No Codex MCP servers reported."
          : displayServers.map((server: any) => `${server.name}: ${server.authStatus} (${server.toolCount} tools, ${server.resourceCount} resources, ${server.templateCount} templates)`).join("\n");
        this.emitSlashCommandResult(command, summary, "completed", {
          servers: displayServers,
        });
        return;
      }

      case "model": {
        if (commandArgs) {
          await this.setModel(commandArgs.split(/\s+/)[0]);
          this.emitSlashCommandResult(command, `Model set to ${this._model}.`);
          return;
        }
        await this.ensureAppServer();
        const result = await this.appServer!.listModels();
        const models = Array.isArray((result as any)?.data) ? (result as any).data : [];
        const names = models
          .filter((model: any) => model && model.hidden !== true)
          .slice(0, 12)
          .map((model: any) => {
            const id = String(model.id || model.model || "unknown");
            const display = model.displayName ? ` (${model.displayName})` : "";
            const current = id === this._model || (!this._model && model.isDefault) ? " current" : "";
            const tier = Array.isArray(model.serviceTiers) && model.serviceTiers.length > 0
              ? `; tiers: ${model.serviceTiers.map((tier: any) => tier.name || tier.id).filter(Boolean).join(", ")}`
              : "";
            return `${id}${display}${current}${tier}`;
          });
        this.emitSlashCommandResult(command, names.length > 0 ? names.join("\n") : `Current model: ${this._model || "default"}`, "completed", {
          models: models
            .filter((model: any) => model && model.hidden !== true)
            .slice(0, 12)
            .map((model: any) => ({
              id: String(model.id || model.model || "unknown"),
              displayName: String(model.displayName || model.id || model.model || "unknown"),
              description: String(model.description || ""),
              current: String(model.id || model.model || "") === this._model || (!this._model && model.isDefault === true),
              tiers: Array.isArray(model.serviceTiers) ? model.serviceTiers.map((tier: any) => tier.name || tier.id).filter(Boolean) : [],
            })),
        });
        return;
      }

      case "permissions": {
        if (!commandArgs) {
          this.emitSlashCommandResult(command, `Current permission mode: ${this.formatPermissionMode(this._permissionMode)}`, "completed", {
            mode: this._permissionMode,
            label: this.formatPermissionMode(this._permissionMode),
          });
          return;
        }
        const normalized = this.normalizeSlashPermissionMode(commandArgs);
        await this.setPermissionMode(normalized);
        this.emitSlashCommandResult(command, `Permission mode set to ${this.formatPermissionMode(this._permissionMode)}.`, "completed", {
          mode: this._permissionMode,
          label: this.formatPermissionMode(this._permissionMode),
        });
        return;
      }

      case "archive": {
        if (!threadId) throw new Error("No Codex thread id for /archive");
        await this.ensureAppServer();
        await this.appServer!.archiveThread(threadId);
        this.emitSlashCommandResult(command, "Codex thread archived.");
        return;
      }

      default:
        throw new Error(`Unsupported Codex slash command: /${command}`);
    }
  }

  private normalizeSlashPermissionMode(value: string): string {
    const mode = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
    switch (mode) {
      case "ask":
      case "default":
      case "workspace":
      case "workspace-write":
        return "default";
      case "read-only":
      case "readonly":
      case "plan":
        return "plan";
      case "yolo":
      case "auto":
      case "bypass":
      case "bypass-permissions":
        return "bypassPermissions";
      case "super-yolo":
      case "superyolo":
      case "never":
        return "superYolo";
      default:
        throw new Error(`Unknown permission mode '${value}'. Use ask, yolo, super-yolo, or read-only.`);
    }
  }

  async buildStatusResult(threadId: string): Promise<{ summary: string; payload: Record<string, unknown> }> {
    const lines: string[] = [];
    let config: any = null;
    let thread: any = null;
    let rateLimits: any = null;
    let usage: any = null;

    if (this.codexDriver === "app-server") {
      await this.ensureAppServer();
      const [configResult, threadResult, limitsResult, usageResult] = await Promise.allSettled([
        this.appServer!.readConfig(this.cwd),
        threadId ? this.appServer!.readThread({ threadId, includeTurns: false }) : Promise.resolve(null),
        this.appServer!.readAccountRateLimits(),
        this.appServer!.readAccountUsage(),
      ]);
      if (configResult.status === "fulfilled") config = (configResult.value as any)?.config || null;
      if (threadResult.status === "fulfilled") thread = (threadResult.value as any)?.thread || null;
      if (limitsResult.status === "fulfilled") rateLimits = limitsResult.value;
      if (usageResult.status === "fulfilled") usage = usageResult.value;
    }

    const threadStatus = thread?.status?.type
      || (this._isCompacting ? "compacting" : this._isRunning ? "running" : "idle");
    const model = this._model || config?.model || "default";
    const effort = config?.model_reasoning_effort || this._effort;

    lines.push(`Thread: ${threadId || "not started"}`);
    if (thread?.name) lines.push(`Title: ${thread.name}`);
    lines.push(`State: ${threadStatus}`);
    lines.push(`CWD: ${thread?.cwd || this.cwd}`);
    lines.push(`Driver: ${this.codexDriver}`);
    lines.push(`Model: ${model}`);
    lines.push(`Effort: ${effort || "default"}`);
    lines.push(`Fast mode: ${this._fastMode ? "on" : "off"}`);
    if (config?.service_tier) lines.push(`Service tier: ${config.service_tier}`);
    lines.push(`Permissions: ${this.formatPermissionMode(this._permissionMode)}`);
    if (config?.sandbox_mode || config?.approval_policy) {
      lines.push(`Codex policy: sandbox=${this.formatScalar(config.sandbox_mode || "default")}, approvals=${this.formatScalar(config.approval_policy || "default")}`);
    }

    const limitPayload = this.buildRateLimitPayload(rateLimits);
    const limitLines = this.formatRateLimitSummary(rateLimits);
    if (limitLines.length > 0) {
      lines.push("");
      lines.push("Limits:");
      lines.push(...limitLines);
    }

    const usagePayload = this.buildUsagePayload(usage);
    const usageLines = this.formatUsageSummary(usage);
    if (usageLines.length > 0) {
      lines.push("");
      lines.push("Usage:");
      lines.push(...usageLines);
    }

    return {
      summary: lines.join("\n"),
      payload: {
        thread: {
          id: threadId || "",
          title: thread?.name || "",
          state: threadStatus,
          cwd: thread?.cwd || this.cwd,
        },
        config: {
          driver: this.codexDriver,
          model,
          effort: effort || "default",
          serviceTier: this._fastMode ? "fast" : config?.service_tier || "",
          fastMode: this._fastMode,
          permissionMode: this._permissionMode,
          permissionLabel: this.formatPermissionMode(this._permissionMode),
          sandbox: config?.sandbox_mode || "default",
          approvals: config?.approval_policy || "default",
        },
        limits: limitPayload,
        usage: usagePayload,
      },
    };
  }

  private buildRateLimitPayload(value: any): Array<Record<string, unknown>> {
    if (!value) return [];
    const byId = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
      ? Object.values(value.rateLimitsByLimitId)
      : [];
    const limits = (byId.length > 0 ? byId : [value.rateLimits]).filter(Boolean) as any[];
    return limits.slice(0, 4).map((limit) => ({
      label: String(limit.limitName || limit.limitId || "Codex"),
      plan: limit.planType ? String(limit.planType) : "",
      credits: limit.credits
        ? (limit.credits.unlimited ? "unlimited" : String(limit.credits.balance ?? "0"))
        : "",
      reached: limit.rateLimitReachedType ? this.formatScalar(limit.rateLimitReachedType) : "",
      primary: this.buildRateLimitWindowPayload(limit.primary),
      secondary: this.buildRateLimitWindowPayload(limit.secondary),
    }));
  }

  private buildRateLimitWindowPayload(window: any): Record<string, unknown> | null {
    if (!window) return null;
    const usedPercent = Number(window.usedPercent);
    return {
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      window: this.formatWindowDuration(window.windowDurationMins),
      resetsAt: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
      resetLabel: this.formatResetTime(window.resetsAt),
    };
  }

  private buildUsagePayload(value: any): Record<string, unknown> {
    const summary = value?.summary;
    if (!summary) return {};
    const today = this.localDateKey();
    const todayBucket = Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets.find((bucket: any) => bucket?.startDate === today)
      : null;
    return {
      lifetimeTokens: Number(summary.lifetimeTokens),
      todayTokens: todayBucket ? Number(todayBucket.tokens) : null,
      peakDailyTokens: Number(summary.peakDailyTokens),
      currentStreakDays: Number(summary.currentStreakDays),
      longestStreakDays: Number(summary.longestStreakDays),
    };
  }

  private formatRateLimitSummary(value: any): string[] {
    if (!value) return [];
    const byId = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
      ? Object.values(value.rateLimitsByLimitId)
      : [];
    const limits = (byId.length > 0 ? byId : [value.rateLimits]).filter(Boolean) as any[];
    return limits.slice(0, 4).map((limit) => {
      const label = limit.limitName || limit.limitId || "Codex";
      const plan = limit.planType ? `; plan ${limit.planType}` : "";
      const primary = this.formatRateLimitWindow("primary", limit.primary);
      const secondary = this.formatRateLimitWindow("secondary", limit.secondary);
      const credits = limit.credits
        ? `; credits ${limit.credits.unlimited ? "unlimited" : String(limit.credits.balance ?? "0")}`
        : "";
      const reached = limit.rateLimitReachedType ? `; reached ${this.formatScalar(limit.rateLimitReachedType)}` : "";
      return `- ${label}: ${[primary, secondary].filter(Boolean).join("; ")}${plan}${credits}${reached}`;
    });
  }

  private formatRateLimitWindow(label: string, window: any): string {
    if (!window) return "";
    const used = Number.isFinite(Number(window.usedPercent)) ? `${Math.round(Number(window.usedPercent))}%` : "unknown";
    const duration = this.formatWindowDuration(window.windowDurationMins);
    const reset = this.formatResetTime(window.resetsAt);
    return `${label} ${used}${duration ? `/${duration}` : ""}${reset ? `, resets ${reset}` : ""}`;
  }

  private formatUsageSummary(value: any): string[] {
    const summary = value?.summary;
    if (!summary) return [];
    const lines = [
      `- Lifetime tokens: ${this.formatNumber(summary.lifetimeTokens)}`,
      `- Peak daily tokens: ${this.formatNumber(summary.peakDailyTokens)}`,
      `- Current streak: ${this.formatNumber(summary.currentStreakDays)} days`,
      `- Longest streak: ${this.formatNumber(summary.longestStreakDays)} days`,
    ];
    const today = this.localDateKey();
    const todayBucket = Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets.find((bucket: any) => bucket?.startDate === today)
      : null;
    if (todayBucket) {
      lines.splice(1, 0, `- Today: ${this.formatNumber(todayBucket.tokens)} tokens`);
    }
    return lines;
  }

  private formatWindowDuration(minutes: unknown): string {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return "";
    if (mins % 1440 === 0) return `${mins / 1440}d`;
    if (mins % 60 === 0) return `${mins / 60}h`;
    return `${mins}m`;
  }

  private formatResetTime(epochSeconds: unknown): string {
    const seconds = Number(epochSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const date = new Date(seconds * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private formatNumber(value: unknown): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return "unknown";
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
  }

  private formatScalar(value: unknown): string {
    if (value === null || value === undefined) return "default";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  private formatPermissionMode(mode: unknown): string {
    switch (mode) {
      case "plan":
        return "Read Only";
      case "default":
        return "Ask";
      case "bypassPermissions":
        return "Yolo";
      case "superYolo":
        return "Super Yolo";
      default:
        return this.formatScalar(mode);
    }
  }

  private formatMcpAuthStatus(status: unknown): string {
    switch (status) {
      case "bearerToken":
        return "authenticated";
      case "oauth":
        return "OAuth";
      case "none":
        return "no auth";
      default:
        return this.formatScalar(status);
    }
  }

  private localDateKey(): string {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private emitSlashCommandResult(
    command: string,
    summary: string,
    status: "completed" | "failed" | "stopped" = "completed",
    payload: Record<string, unknown> = {},
  ): void {
    const sid = this.threadId || this.sessionId || this._resumeSessionId || "";
    const taskId = `codex_slash_${command}_${crypto.randomUUID()}`;
    const content = `/${command}\n${summary}`;
    if (sid) {
      appendHistory(sid, {
        role: "notification",
        content,
        status,
        originToolUseId: `codex_slash_${command}`,
        commandName: command,
        commandPayload: payload,
        timestamp: now(),
      });
    }
    this.send({
      type: "codex_command_result",
      taskId,
      command,
      status,
      summary: content,
      payload,
      sessionId: sid,
      parentToolUseId: `codex_slash_${command}`,
    } as any);
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
  async injectMessage(text: string, priority: 'now' | 'next' | 'later' = 'now', messageId?: string, options: CodexRunOptions = {}): Promise<void> {
    if (!this._isRunning) {
      // Race: turn finished between the client deciding to queue and us
      // receiving the message. Just run it directly.
      void this.runQueryWithOptions(text, undefined, options).catch((err) => {
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
            fastMode: options.fastMode,
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
      this._queuedPrompts.push({ text, priority, messageId, fastMode: options.fastMode, resolve, reject });
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
  async runQueryWithOptions(prompt: string, resumeSessionId?: string, options: CodexRunOptions = {}): Promise<void> {
    if (options.fastMode === undefined && options.messageId === undefined) {
      return this.runQuery(prompt, resumeSessionId);
    }
    const previousFastMode = this._fastMode;
    const previousClientMessageId = this._currentClientMessageId;
    if (options.fastMode !== undefined) this._fastMode = options.fastMode;
    this._currentClientMessageId = options.messageId || null;
    try {
      return await this.runQuery(prompt, resumeSessionId);
    } finally {
      this._fastMode = previousFastMode;
      this._currentClientMessageId = previousClientMessageId;
    }
  }

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
        ...(this._currentClientMessageId ? { clientMessageId: this._currentClientMessageId } : {}),
      } as any);
    } else {
      this._pendingUserPrompt = {
        text: prompt,
        uuid: userMsgUuid,
        ...(this._currentClientMessageId ? { messageId: this._currentClientMessageId } : {}),
      };
    }

    const mcpRegistration = registerCodexAppMcp(this.createAppToolContext());
    const mcpUrl = this.buildCodexMcpUrl(mcpRegistration.token);
    const args = this.threadId
      ? this.buildResumeArgs(this.threadId, mcpUrl)
      : this.buildExecArgs(mcpUrl);

    const codex = buildCodexSpawn(args);
    this.proc = spawn(codex.command, codex.args, {
      cwd: this.cwd, // resume relies on this — it does NOT inherit cwd from the original session
      env: codex.env,
      shell: codex.shell,
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
            this.runQueryWithOptions(nextPrompt.text, this.sessionId ?? undefined, {
              fastMode: nextPrompt.fastMode,
              messageId: nextPrompt.messageId,
            })
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

    this._pendingUserPrompt = {
      text: prompt,
      uuid: crypto.randomUUID(),
      ...(this._currentClientMessageId ? { messageId: this._currentClientMessageId } : {}),
    };

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
      const turnModel = collaborationMode ? this.codexModel() : undefined;
      const turn = await this.appServer!.startTurn({
        threadId: this.threadId,
        cwd: this.cwd,
        input: this.buildAppServerTurnInput(prompt),
        ...(turnModel ? { model: turnModel } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      });
      this.activeAppServerTurnId = this.extractTurnId(turn) || this.activeAppServerTurnId;
      this.flushPendingUserPrompt();

      await completion;

      const nextPrompt = this._abortRequested ? null : this.dequeueNextPrompt();
      if (nextPrompt) {
        nextPrompt.resolve();
        this._isRunning = false;
        this.activeAppServerTurnId = null;
        this.appServerTurnSettler = null;
        await this.runQueryWithOptions(nextPrompt.text, this.sessionId ?? undefined, {
          fastMode: nextPrompt.fastMode,
          messageId: nextPrompt.messageId,
        });
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
      await this.stopAppServerClient();
    }
  }

  private async ensureAppServer(): Promise<void> {
    if (this.appServerIdleStopTimer) {
      clearTimeout(this.appServerIdleStopTimer);
      this.appServerIdleStopTimer = null;
    }
    if (!this.appServer) {
      const codex = buildCodexSpawn(["app-server", "--listen", "stdio://"]);
      this.appServer = new CodexAppServerClient({
        cwd: this.cwd,
        command: codex.command,
        args: codex.args,
        env: codex.env,
        shell: codex.shell,
        requestTimeoutMs: 60_000,
        startupTimeoutMs: 30_000,
      });
      this.appServer.on("notification", (notification: CodexAppServerNotification) => {
        this.handleAppServerNotification(notification.method, notification.params);
        this.onActivity?.();
      });
      this.appServer.on("response", () => {
        this.scheduleAppServerIdleStop();
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

    if (this.appServerInitialized) return;
    if (this.appServerInitializePromise) {
      await this.appServerInitializePromise;
      return;
    }
    this.appServerInitializePromise = (async () => {
      await this.appServer!.initialize({
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
    })();
    try {
      await this.appServerInitializePromise;
    } finally {
      this.appServerInitializePromise = null;
    }
  }

  private scheduleAppServerIdleStop(delayMs = 15_000): void {
    if (!this.appServer || this._isRunning || this._isCompacting || this.appServerTurnSettler) return;
    if (this.appServerIdleStopTimer) clearTimeout(this.appServerIdleStopTimer);
    this.appServerIdleStopTimer = setTimeout(() => {
      this.appServerIdleStopTimer = null;
      if (!this.appServer || this._isRunning || this._isCompacting || this.appServerTurnSettler) return;
      void this.stopAppServerClient();
    }, delayMs);
  }

  private async stopAppServerClient(): Promise<void> {
    if (this.appServerIdleStopTimer) {
      clearTimeout(this.appServerIdleStopTimer);
      this.appServerIdleStopTimer = null;
    }
    const client = this.appServer;
    this.appServer = null;
    this.appServerInitialized = false;
    this.appServerInitializePromise = null;
    if (this.appServerMcpRegistration) {
      this.appServerMcpRegistration.unregister();
      this.appServerMcpRegistration = null;
    }
    if (!client) return;
    try {
      await client.stop();
    } catch (err: any) {
      console.warn(`[codex app-server] cleanup failed: ${err?.message || err}`);
    } finally {
      client.removeAllListeners();
    }
  }

  async dispose(): Promise<void> {
    await this.stopAppServerClient();
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
    const model = this.codexModel();
    return {
      cwd: this.cwd,
      sandbox: this._sandbox,
      approvalPolicy: this._approvalPolicy,
      approvalsReviewer: this._approvalsReviewer,
      ...(model ? { model } : {}),
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
    const config: Record<string, unknown> = {
      model_reasoning_effort: this.codexReasoningEffort(),
      mcp_servers: {
        socketagent_app: {
          url: mcpUrl,
        },
      },
    };
    if (this._fastMode) {
      config.service_tier = "fast";
      config.features = { fast_mode: true };
    }
    return config;
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

  }

  private flushPendingUserPrompt(): void {
    if (!this.sessionId || !this._pendingUserPrompt) return;
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
      ...(this._pendingUserPrompt.messageId ? { clientMessageId: this._pendingUserPrompt.messageId } : {}),
    } as any);
    this._pendingUserPrompt = null;
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
      void this.stopAppServerClient();
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
      fastMode: steer.fastMode,
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
    void this.runQueryWithOptions(nextPrompt.text, undefined, {
      fastMode: nextPrompt.fastMode,
      messageId: nextPrompt.messageId,
    })
      .catch((err) => nextPrompt.reject(err instanceof Error ? err : new Error(String(err))));
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
        ...(pending.messageId ? { clientMessageId: pending.messageId } : {}),
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

        case "mcpServer/elicitation/request": {
          await this.handleMcpServerElicitation(params, respond);
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

  private async handleMcpServerElicitation(
    params: Record<string, any>,
    respond: CodexAppServerRequestResponder,
  ): Promise<void> {
    const serverName = String(params.serverName || params.server_name || params.name || "");
    const normalizedServerName = serverName.toLowerCase().replace(/-/g, "_");
    const request = params.request && typeof params.request === "object" ? params.request : {};
    const requestMethod = String((request as any).method || "");
    const requestParams = (request as any).params && typeof (request as any).params === "object"
      ? (request as any).params
      : {};
    const message = String((requestParams as any).message || "");
    const isSocketAgentAppServer = normalizedServerName === "socketagent_app"
      || normalizedServerName === "socketagent"
      || serverName === "SocketAgent";

    if (isSocketAgentAppServer) {
      console.log(
        `[codex app-server] accepted MCP elicitation server=${serverName || "unknown"} method=${requestMethod || "unknown"} message=${message.slice(0, 160)}`,
      );
      respond({ result: { action: "accept", content: {} } });
      return;
    }

    console.warn(
      `[codex app-server] declined MCP elicitation server=${serverName || "unknown"} method=${requestMethod || "unknown"} message=${message.slice(0, 160)}`,
    );
    respond({ result: { action: "cancel" } });
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
        this.emitCompactBoundary(sid, this._compactBoundaryTrigger);
        this.scheduleAppServerIdleStop();
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
        const itemId = String(p?.itemId || p?.item?.id || "agent");
        const delta = String(p?.delta ?? "");
        this.appServerAgentText.set(itemId, (this.appServerAgentText.get(itemId) || "") + delta);
        if (delta) {
          this.send({ type: "text", content: delta, sessionId: sid, streamId: itemId } as ServerMessage);
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
        if (this._compactBoundaryTrigger !== "manual") {
          this._compactBoundaryTrigger = "auto";
        }
        this.send({ type: "compacting", active: true, sessionId: sid } as any);
      } else {
        this._isCompacting = false;
        this.send({ type: "compacting", active: false, sessionId: sid } as any);
        this.emitCompactBoundary(sid, this._compactBoundaryTrigger);
        this.scheduleAppServerIdleStop();
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
    const boundaryTrigger = trigger === "manual" ? "manual" : "auto";
    this._compactBoundaryTrigger = "auto";
    const preTokens = this.currentContextTokenTotal();
    this.send({
      type: "compact_boundary",
      trigger: boundaryTrigger,
      preTokens,
      sessionId: sid,
    } as any);
    appendHistory(sid, {
      role: "assistant",
      content: `[compact_boundary:${preTokens}:${boundaryTrigger}]`,
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
        this.flushPendingUserPrompt();
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

  private codexReasoningEffort(): string {
    return this._effort === "max" ? "high" : this._effort;
  }

  private codexModel(): string | undefined {
    if (this._model) return this._model;
    const envModel = process.env.CODEX_MODEL?.trim();
    if (envModel) return envModel;

    try {
      const configPath = path.join(os.homedir(), ".codex", "config.toml");
      const config = fs.readFileSync(configPath, "utf8");
      const match = config.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m);
      if (match?.[1]) return match[1];
    } catch {
      // Fall through to Codex's current default when config is absent/unreadable.
    }

    return "gpt-5.5";
  }

  private codexDeveloperInstructions(): string | null {
    const parts: string[] = [];

    parts.push(
      `SocketAgent app tools are available through the MCP server named socketagent_app: ${SOCKETAGENT_APP_TOOLS.map((tool) => tool.name).join(", ")}. Use SendFile with an absolute file_path when the user asks you to send, share, or transfer a file to their phone. Use NotifyUser for important phone push notifications, ScheduleReminder for device reminders, ScheduleTask for scheduled agent work, Monitor for background command monitoring, and Speak only when text-to-speech is enabled or requested. If a SocketAgent app tool is not immediately visible, use tool discovery for socketagent_app instead of telling the user it must be loaded.`,
    );

    parts.push(SOCKETAGENT_FILE_LINK_INSTRUCTIONS);

    const emailToolsPath = path.resolve(__dirname, "..", "tools", "email-tools.js");
    if (fs.existsSync(emailToolsPath)) {
      parts.push(
        `Outlook email/calendar CLI is available at ${emailToolsPath}. Use it when the user asks to work with Outlook mail, attachments, drafts, sends, or calendar data. Examples: \`node ${emailToolsPath} list 10\`, \`node ${emailToolsPath} read <email-id>\`, \`node ${emailToolsPath} search <query> [count]\`, \`node ${emailToolsPath} attachments <email-id>\`, \`node ${emailToolsPath} download-attachment <email-id> <attachment-id-or-name> [output-dir]\`, \`node ${emailToolsPath} agenda\`, and \`node ${emailToolsPath} events [days] [count]\`. Sending commands require user approval.`,
      );
    }

    const ibsToolsPath = path.resolve(__dirname, "..", "tools", "ibs-tools.js");
    if (fs.existsSync(ibsToolsPath)) {
      parts.push(
        `IBS/JCI Installation Information System CLI is available at ${ibsToolsPath}. Use it when the user asks about IBS contracts, job summaries, cost schedules, labor schedules, or current IBS contract lists. Examples: \`node ${ibsToolsPath} summary <job-id>\`, \`node ${ibsToolsPath} costs <job-id>\`, \`node ${ibsToolsPath} labor <job-id>\`, and \`node ${ibsToolsPath} list\`. It requires a valid IBS browser-cookie session; if expired, trigger IBS auth through the SocketAgent app.`,
      );
    }

    const oneDriveToolsPath = path.resolve(__dirname, "..", "tools", "onedrive-tools.js");
    if (fs.existsSync(oneDriveToolsPath)) {
      parts.push(
        `OneDrive/SharePoint CLI is available at ${oneDriveToolsPath}. Use it when the user asks to list, search, download, upload, or inspect OneDrive/SharePoint/project-drive files. Examples: \`node ${oneDriveToolsPath} ls [folder-path]\`, \`node ${oneDriveToolsPath} search <query>\`, \`node ${oneDriveToolsPath} download <remote-path> [output-path]\`, \`node ${oneDriveToolsPath} find-project <project-number>\`, \`node ${oneDriveToolsPath} drive-ls <drive-id> [folder-path]\`, and \`node ${oneDriveToolsPath} drive-upload <local> <drive-id> <path>\`. Upload/write operations should only be done when clearly requested.`,
      );
    }

    for (const plugin of this._plugins) {
      if (!plugin.toolContextFragment) continue;
      const fragment = plugin.toolContextFragment();
      if (fragment) parts.push(fragment);
    }

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
    const model = this.codexModel();
    return {
      mode: this._collaborationMode,
      settings: {
        model,
        reasoning_effort: this.codexReasoningEffort(),
        developer_instructions: developerInstructions ?? null,
      },
    };
  }

  private codexDeveloperInstructionsConfigArg(): string | null {
    const developerInstructions = this.codexDeveloperInstructions();
    if (!developerInstructions) return null;
    return `developer_instructions=${JSON.stringify(developerInstructions)}`;
  }

  private codexFastModeConfigArgs(): string[] {
    return this._fastMode
      ? ["-c", `service_tier="fast"`, "-c", "features.fast_mode=true"]
      : [];
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
    args.push(...this.codexFastModeConfigArgs());
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
    args.push(...this.codexFastModeConfigArgs());
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
  const clientCwd = resolveStandaloneAppServerCwd(cwd);
  const codex = buildCodexSpawn(["app-server", "--listen", "stdio://"]);
  const client = new CodexAppServerClient({
    cwd: clientCwd,
    command: codex.command,
    args: codex.args,
    env: codex.env,
    shell: codex.shell,
    requestTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
  });
  client.on("error", () => {
    // The pending JSON-RPC request also rejects; this listener prevents EventEmitter
    // from treating spawn failures as uncaught exceptions.
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

function resolveStandaloneAppServerCwd(cwd: string): string {
  const candidates = [cwd, process.cwd(), os.homedir(), "/tmp"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        if (candidate !== cwd) {
          console.warn(`[codex app-server] cwd missing for standalone request (${cwd}); using ${candidate}`);
        }
        return candidate;
      }
    } catch {
      // Try the next fallback.
    }
  }
  return process.cwd();
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

const CODEX_AVAILABILITY_CACHE_MS = 5000;
let _cachedCodexAvailability: { checkedAt: number; value: { available: boolean; reason?: string } } | null = null;

export function invalidateCodexAvailabilityCache(): void {
  _cachedCodexAvailability = null;
}

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
  const now = Date.now();
  if (_cachedCodexAvailability && now - _cachedCodexAvailability.checkedAt < CODEX_AVAILABILITY_CACHE_MS) {
    return _cachedCodexAvailability.value;
  }

  const cache = (value: { available: boolean; reason?: string }): { available: boolean; reason?: string } => {
    _cachedCodexAvailability = { checkedAt: Date.now(), value };
    return value;
  };

  try {
    const codex = buildCodexSpawn(["--version"]);
    const result = spawnSync(codex.command, codex.args, {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: codex.env,
      shell: codex.shell,
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return cache({
        available: false,
        reason: code === "ENOENT"
          ? "Codex CLI was not found on PATH"
          : `Codex CLI probe failed: ${result.error.message}`,
      });
    }

    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      return cache({
        available: false,
        reason: detail
          ? `Codex CLI probe exited ${result.status}: ${detail.slice(0, 300)}`
          : `Codex CLI probe exited ${result.status}`,
      });
    }

    const home = process.env.HOME || os.homedir();
    if (!fs.existsSync(path.join(home, ".codex", "auth.json"))) {
      return cache({
        available: false,
        reason: "Codex CLI is installed but ~/.codex/auth.json is missing",
      });
    }

    return cache({ available: true });
  } catch (e: any) {
    return cache({
      available: false,
      reason: `Codex availability check failed: ${e?.message || String(e)}`,
    });
  }
}

/**
 * Returns the list of agent backends this server can drive. Codex availability
 * is rechecked on a short cache window so install/auth fixes can be picked up
 * without a SocketAgent restart.
 *
 * Claude is present when enabled (the Agent SDK ships with the server). Codex
 * is present iff enabled, the `codex` CLI is on PATH, and `~/.codex/auth.json`
 * exists.
 */
export function detectAvailableBackends(): Backend[] {
  const enabled = getEnabledBackendSet();
  const list: Backend[] = [];
  if (enabled.has("claude")) list.push("claude");
  try {
    if (enabled.has("codex") && getCodexAvailability().available) list.push("codex");
  } catch (e: any) {
    console.error(`[codex] backend detection failed: ${e?.message || String(e)}`);
  }
  return list;
}
