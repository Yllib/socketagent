/**
 * A SocketAgent chat driven by Google's Antigravity CLI (`agy acp`), for
 * Gemini models on the user's own Google AI plan.
 *
 * One agy process serves the chat while it is in use and stops after it has
 * been idle a while; the conversation lives in agy, so the next turn resumes
 * it with session/resume. The ACP session ID is the SocketAgent session ID.
 *
 * It exposes the same members as CodexSession that index.ts calls through
 * the Session union. Members for features agy has no equivalent for are
 * no-ops or report that they are unsupported.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";
import type { ClientTransport } from "./client-transport";
import type { ComputersToolExecutor } from "./computers-tool";
import type { AgentSessionToolExecutor, DelegatedAgentLiveActivity } from "./delegated-agent-types";
import {
  ACP_AUTH_REQUIRED,
  AcpClient,
  AcpError,
  acpPromptResultSchema,
  acpSessionSetupSchema,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpNotification,
  type AcpResponder,
} from "./gemini-acp-client";
import { discoverAgyModels, resolveAgyCommand } from "./gemini-cli";
import type {
  AgentEffort,
  AgentSessionSettings,
  ContextUsage,
  ErrorServerMessage,
  HistoryEntry,
  McpServerStatusEntry,
  QuestionServerMessage,
  ServerMessage,
  SessionInfo,
  SessionLifetime,
  SupportedCommandsServerMessage,
  SupportedModelsServerMessage,
  UsageInfo,
} from "./protocol";
import type { SessionContext, SocketAgentPlugin } from "./plugin-api";
import {
  appendHistory,
  getSession,
  markQuestionAnswered,
  positionSessionMessage,
  recordSessionError,
  recordUserPrompt,
  remapSession,
  saveSession,
  updateSessionActivity,
  updateSessionAgentSettings,
  updateSessionContextUsage,
} from "./session-store";
import { ConnectionFailureReporter, isBackendConnectionError } from "./backend-connection";
import { stopAppMonitor, stopAppMonitorsForSession, type AppToolContext } from "./app-tool-handlers";
import { registerCodexAppMcp, socketAgentAppToolNames } from "./codex-app-mcp";
import { boardToolset, commitBoardTurn, prepareBoardTurn, type BoardToolset } from "./project-board-tool";
import { buildSocketAgentIntegrationInstructions } from "./socketagent-instructions";
import { pendingSecureInputMessagesForSession, redactSecretsDeep, secureInputInventoryForAgent } from "./secure-input-store";
import { SessionEventDelivery } from "./session-event-delivery";
import { LatestSnapshotDispatcher } from "./latest-snapshot-dispatcher";
import { maybeSendAgentAttentionPush } from "./push-notifications";
import { createInteractiveRequestId } from "./interactive-request-id";
import { oldestOpenedAt, waitForInteractiveAnswer, type PendingInteractiveAnswer } from "./interactive-answer";
import { toolApprovalMarkdown } from "./tool-approval";
import { getCachedModelCatalog, modelCatalogIsFresh, saveCachedModelCatalog } from "./model-catalog-store";
import { recordModelChange } from "./model-change";
import { requestTranscriptAccess } from "./transcript-access-approval";
import { isRecord, unknownArray } from "./value-guards";
import { promptTitle } from "./prompt-title";
import { recordSessionMemoryContextUsage, remapSessionMemory } from "./session-memory-store";

const IDLE_STOP_MS = 10 * 60_000;
const OUT_OF_TURN_STALL_MS = 2 * 60_000;
const MCP_SERVER_NAME = "socketagent_app";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MAX_INLINE_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Extracts local image attachments referenced by `[Attached file: /path]` markers
 * in a prompt into ACP image blocks so Gemini receives native vision input.
 */
export function extractAttachedImageBlocks(prompt: string): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  const seen = new Set<string>();
  const regex = /\[Attached file:\s*([^\]\r\n]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    const filePath = match[1].trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const mimeType = IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!mimeType) continue;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INLINE_PROMPT_IMAGE_BYTES) continue;
      blocks.push({ type: "image", data: fs.readFileSync(filePath).toString("base64"), mimeType });
    } catch {
      // Missing or unreadable attachment: leave the text path marker for the agent.
    }
  }
  return blocks;
}

export interface ParsedElicitationField {
  key: string;
  otherKey?: string;
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; value: string; description?: string }>;
}

function parseSchemaOptions(schema: Record<string, unknown>): Array<{ label: string; value: string; description?: string }> {
  const choices = unknownArray(schema.oneOf).length > 0 ? unknownArray(schema.oneOf) : unknownArray(schema.anyOf);
  if (choices.length > 0) {
    return choices.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.const !== "string") return [];
      const label = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : entry.const;
      const description = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : undefined;
      return [{ label, value: entry.const, ...(description ? { description } : {}) }];
    });
  }
  const enumValues = unknownArray(schema.enum);
  if (enumValues.length > 0) {
    return enumValues.flatMap((entry) => (typeof entry === "string" ? [{ label: entry, value: entry }] : []));
  }
  return [];
}

/** Parses an ACP `elicitation/create` form schema into SocketAgent QuestionCard entries. */
export function parseAcpElicitationQuestions(params: Record<string, unknown>): ParsedElicitationField[] {
  const requestedSchema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = requestedSchema && isRecord(requestedSchema.properties) ? requestedSchema.properties : null;
  if (!properties) return [];

  const keys = Object.keys(properties);
  const keySet = new Set(keys);
  const fallbackPrompt = typeof params.message === "string" && params.message.trim() ? params.message.trim() : "Question";
  const fields: ParsedElicitationField[] = [];

  for (const key of keys) {
    if (key.endsWith("_other") && keySet.has(key.slice(0, -"_other".length))) continue;
    const prop = properties[key];
    if (!isRecord(prop)) continue;
    const otherCandidate = `${key}_other`;
    const otherKey = keySet.has(otherCandidate) ? otherCandidate : undefined;
    const multiSelect = prop.type === "array";
    const optionSource = multiSelect && isRecord(prop.items) ? prop.items : prop;
    const options = parseSchemaOptions(optionSource);
    const question = stringField(prop, "title", "description") ?? fallbackPrompt;
    const header = keys.length > 1 ? `Question ${fields.length + 1}` : "Question";
    fields.push({ key, ...(otherKey ? { otherKey } : {}), question, header, multiSelect, options });
  }
  return fields;
}

/** Maps SocketAgent `QuestionCard` answers back into an ACP `elicitation/create` content object. */
export function buildAcpElicitationContent(
  fields: ParsedElicitationField[],
  answers: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = answers[field.question];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (field.multiSelect) {
      const parts = trimmed.split(/,\s*/).map((part) => part.trim()).filter(Boolean);
      const selected: string[] = [];
      const custom: string[] = [];
      for (const part of parts) {
        const match = field.options.find((opt) => opt.label === part || opt.value === part);
        if (match) selected.push(match.value);
        else custom.push(part);
      }
      if (selected.length > 0) content[field.key] = selected;
      if (custom.length > 0) {
        if (field.otherKey) content[field.otherKey] = custom.join(", ");
        else if (selected.length === 0) content[field.key] = custom;
      }
      continue;
    }
    const match = field.options.find((opt) => opt.label === trimmed || opt.value === trimmed);
    if (match) {
      content[field.key] = match.value;
    } else if (field.otherKey) {
      content[field.otherKey] = trimmed;
    } else {
      content[field.key] = trimmed;
    }
  }
  return content;
}

function now(): string {
  return new Date().toISOString();
}

function isEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

function selectValues(option: AcpConfigOption | undefined): Array<{ value: string; name: string; description?: string }> {
  return unknownArray(option?.options).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.value !== "string") return [];
    return [{
      value: entry.value,
      name: typeof entry.name === "string" ? entry.name : entry.value,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    }];
  });
}

/** Text of a tool call's content blocks, or its raw output when there are none. */
function toolOutputText(update: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of unknownArray(update.content)) {
    if (!isRecord(item)) continue;
    const inner = isRecord(item.content) ? item.content : item;
    if (inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
    else if (item.type === "diff" && typeof item.path === "string") {
      parts.push(`${item.path}\n${typeof item.newText === "string" ? item.newText : ""}`);
    }
  }
  if (parts.length > 0) return parts.join("\n");
  const raw = update.rawOutput;
  if (isRecord(raw) && typeof raw.output === "string") return raw.output;
  if (typeof raw === "string") return raw;
  return raw === undefined ? "" : JSON.stringify(raw, null, 2);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstLocationPath(update: Record<string, unknown>): string | undefined {
  for (const entry of unknownArray(update.locations)) {
    if (isRecord(entry) && typeof entry.path === "string" && entry.path.length > 0) return entry.path;
  }
  return undefined;
}

function firstDiffBlock(update: Record<string, unknown>): { path?: string; oldText?: string; newText?: string } | null {
  for (const item of unknownArray(update.content)) {
    if (!isRecord(item) || item.type !== "diff") continue;
    return {
      ...(typeof item.path === "string" && item.path ? { path: item.path } : {}),
      ...(typeof item.oldText === "string" ? { oldText: item.oldText } : {}),
      ...(typeof item.newText === "string" ? { newText: item.newText } : {}),
    };
  }
  return null;
}

/**
 * Translates an `agy acp` tool call payload into SocketAgent's canonical tool
 * names and input keys so the app renders native Bash, Edit (diff), Write,
 * Read, Grep, Glob, WebSearch, WebFetch, Agent, and SocketAgent MCP cards.
 */
export function normalizeGeminiToolCall(update: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  const rawName = typeof update.name === "string" && update.name
    ? update.name
    : typeof update.kind === "string" && update.kind
      ? update.kind
      : "tool";
  const rawInput = isRecord(update.rawInput) ? update.rawInput : isRecord(update.args) ? update.args : {};
  const title = typeof update.title === "string" && update.title.trim() ? update.title.trim() : undefined;
  const kind = typeof update.kind === "string" ? update.kind : "";
  const mcpPrefix = `mcp_${MCP_SERVER_NAME}_`;
  if (rawName.startsWith(mcpPrefix)) {
    return {
      tool: rawName.slice(mcpPrefix.length),
      input: { ...rawInput },
    };
  }

  if (rawName === "run_command" || (kind === "execute" && (stringField(rawInput, "CommandLine", "command") !== undefined))) {
    const command = stringField(rawInput, "CommandLine", "command") ?? title ?? "";
    const summary = stringField(rawInput, "toolSummary", "description") ?? (title && title !== command ? title : undefined);
    return {
      tool: "Bash",
      input: {
        command,
        ...(summary ? { description: summary } : {}),
      },
    };
  }

  if (rawName === "edit_file" || rawName === "replace_file_content" || rawName === "multi_replace_file_content") {
    const diff = firstDiffBlock(update);
    const filePath = stringField(rawInput, "Path", "TargetFile", "file_path", "path") ?? diff?.path ?? firstLocationPath(update) ?? "";
    const oldString = stringField(rawInput, "Target", "TargetContent", "old_string") ?? diff?.oldText ?? "";
    const newString = typeof rawInput.Replacement === "string"
      ? rawInput.Replacement
      : typeof rawInput.ReplacementContent === "string"
        ? rawInput.ReplacementContent
        : typeof rawInput.new_string === "string"
          ? rawInput.new_string
          : diff?.newText ?? "";
    return {
      tool: "Edit",
      input: {
        ...(filePath ? { file_path: filePath } : {}),
        ...(oldString || newString ? { old_string: oldString, new_string: newString } : rawInput),
      },
    };
  }

  if (rawName === "write_file" || rawName === "write_to_file") {
    const filePath = stringField(rawInput, "Path", "TargetFile", "file_path", "path") ?? firstLocationPath(update) ?? "";
    const content = typeof rawInput.Content === "string"
      ? rawInput.Content
      : typeof rawInput.CodeContent === "string"
        ? rawInput.CodeContent
        : typeof rawInput.content === "string"
          ? rawInput.content
          : "";
    return {
      tool: "Write",
      input: {
        ...(filePath ? { file_path: filePath } : {}),
        content,
      },
    };
  }

  if (rawName === "read_file" || rawName === "view_file") {
    const filePath = stringField(rawInput, "Path", "AbsolutePath", "file_path", "path") ?? firstLocationPath(update) ?? "";
    const startLine = numberField(rawInput, "StartLine", "offset");
    const endLine = numberField(rawInput, "EndLine");
    const limit = numberField(rawInput, "limit")
      ?? (startLine !== undefined && endLine !== undefined ? Math.max(1, endLine - startLine + 1) : undefined);
    return {
      tool: "Read",
      input: {
        ...(filePath ? { file_path: filePath } : {}),
        ...(startLine !== undefined ? { offset: startLine } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    };
  }

  if (rawName === "grep_search") {
    const pattern = stringField(rawInput, "Query", "Pattern", "pattern") ?? title ?? "";
    const searchPath = stringField(rawInput, "SearchPath", "Path", "path");
    return {
      tool: "Grep",
      input: {
        pattern,
        ...(searchPath ? { path: searchPath } : {}),
      },
    };
  }

  if (rawName === "find_by_name" || rawName === "list_dir") {
    const pattern = stringField(rawInput, "Pattern", "pattern") ?? "*";
    const searchPath = stringField(rawInput, "SearchDirectory", "DirectoryPath", "Path", "path");
    return {
      tool: "Glob",
      input: {
        pattern,
        ...(searchPath ? { path: searchPath } : {}),
      },
    };
  }

  if (rawName === "search_web") {
    const query = stringField(rawInput, "query", "Query") ?? title ?? "";
    const domain = stringField(rawInput, "domain", "Domain");
    return {
      tool: "WebSearch",
      input: {
        query,
        ...(domain ? { domain } : {}),
      },
    };
  }

  if (rawName === "read_url_content" || rawName === "fetch_url") {
    const url = stringField(rawInput, "Url", "url") ?? title ?? "";
    return {
      tool: "WebFetch",
      input: { url },
    };
  }

  if (rawName === "invoke_subagent") {
    const description = stringField(rawInput, "Role", "description") ?? title ?? "Subagent";
    const prompt = stringField(rawInput, "Prompt", "prompt") ?? "";
    const subagentType = stringField(rawInput, "TypeName", "subagent_type") ?? "subagent";
    return {
      tool: "Agent",
      input: {
        description,
        prompt,
        subagent_type: subagentType,
      },
    };
  }

  const input: Record<string, unknown> = { ...rawInput };
  if (title && !("description" in input)) input.description = title;
  return { tool: rawName, input };
}

interface ActiveToolCall {
  tool: string;
  input: Record<string, unknown>;
  lastStreamedOutput: string;
  streamChunkIndex: number;
}

interface QueuedPrompt {
  text: string;
  messageId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class GeminiSession {
  public _delegationSupervisorSessionId?: string;
  public projectBoardHint: string | null = null;
  sessionLifetime: SessionLifetime | undefined;
  public onActivity?: () => void;
  public onBeforeRun?: (resumeSessionId?: string) => void;
  public onClose?: () => void;
  public onHarnessRunStateChanged?: (running: boolean) => void;
  public onSessionIdChanged?: (previousSessionId: string, nextSessionId: string) => void;
  public onMonitorOutput?: (text: string) => void;
  public onAgentSessionRequest?: AgentSessionToolExecutor;
  public onQuestionAsked?: (question: QuestionServerMessage) => void;
  public onComputersRequest?: ComputersToolExecutor;
  public replacesSessionId?: string;
  public _resumeSessionId?: string;

  private sessionId: string | null = null;
  private client: AcpClient | null = null;
  /** The ACP session the running agy process has open, once session/new or session/resume answered. */
  private openSessionId: string | null = null;
  private configOptions: AcpConfigOption[] = [];
  private availableModelIds: string[] = [];
  private mcpRegistration: ReturnType<typeof registerCodexAppMcp> | null = null;
  private boardTools: BoardToolset | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private abortKillTimer: ReturnType<typeof setTimeout> | null = null;

  private _isRunning = false;
  private _outOfTurnRunning = false;
  private outOfTurnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  protected outOfTurnSettleMs = 350;
  /** How long Stop waits for agy to cancel before stopping the process. */
  protected abortKillMs = 5_000;
  private _runStartedAt: string | null = null;
  private _abortRequested = false;
  private _model: string | null = null;
  private _effort: AgentEffort = "high";
  private _permissionMode = "default";
  private _appendSystemPrompt = "";
  private _systemPromptOverride: string | undefined;
  private _pendingTransferContext: string | null = null;
  private _disallowedTools: string[] = [];
  private _additionalDirectories: string[] = [];
  private _ttsEnabled = false;
  private _ttsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  private _kokoroVoice = "af_heart";
  private _kokoroSpeed = 1.0;
  private _lastAssistantText = "";
  private _lastUsage: UsageInfo | null = null;
  private _contextWindow = 0;
  private _lastContextUsed = 0;
  private _lastSupportedModels: SupportedModelsServerMessage | null = null;
  private _lastSupportedCommands: SupportedCommandsServerMessage | null = null;
  private _queuedPrompts: QueuedPrompt[] = [];
  private _pendingSteers: QueuedPrompt[] = [];
  private _activePromptGeneration = 0;
  private _activePromptPromise: Promise<unknown> | null = null;
  private _steerDispatchPromise: Promise<void> | null = null;
  private _currentClientMessageId: string | null = null;
  private _currentPrompt = "";

  /** The assistant message or thought being streamed, finished when a tool call or the turn ends. */
  private textStream: { id: string; content: string } | null = null;
  private thoughtStream: { id: string; content: string; startedAtMs: number } | null = null;
  private activeToolCalls = new Map<string, ActiveToolCall>();
  private backgroundToolCalls = new Map<string, ActiveToolCall>();
  private pendingQuestions = new Map<string, PendingInteractiveAnswer>();
  private clientSockets = new Set<ClientTransport>();
  private sessionEventDelivery = new SessionEventDelivery<ServerMessage>((message) => this.dispatchToClients(message));
  private streamSnapshots = new LatestSnapshotDispatcher<ServerMessage>((message) => this.sendImmediately(message));
  readonly connectionFailures = new ConnectionFailureReporter("gemini", (message) => {
    const card: ErrorServerMessage = { type: "error", message, sessionId: this.sessionId || undefined };
    this.connectionChecked.add(card);
    this.send(card);
  });
  private readonly connectionChecked = new WeakSet<ErrorServerMessage>();

  constructor(
    private ws: ClientTransport,
    private cwd: string,
    private _plugins: SocketAgentPlugin[] = [],
  ) {
    this.clientSockets.add(ws);
  }

  // ─── State the server reads ───────────────────────────────────────

  get oldestOpenCardAt(): number | undefined { return oldestOpenedAt(this.pendingQuestions); }
  get isRunning(): boolean { return this._isRunning || this._outOfTurnRunning; }
  get isCompacting(): boolean { return false; }
  get isWarmIdle(): boolean { return this.client !== null && !this.isBusy; }
  get hasLiveBackend(): boolean { return this.client !== null; }
  get isBusy(): boolean {
    return this._isRunning
      || this._outOfTurnRunning
      || this.backgroundToolCalls.size > 0
      || this._queuedPrompts.length > 0
      || this._pendingSteers.length > 0
      || this.pendingQuestions.size > 0;
  }
  get activeStartedAt(): string | null { return this._runStartedAt; }
  get permissionMode(): string { return this._permissionMode; }
  get sessionModel(): string | null { return this._model; }
  get lastUsage(): UsageInfo | null { return this._lastUsage; }
  get activeBackgroundTasks(): Map<string, string> {
    return new Map(
      [...this.backgroundToolCalls.entries()].map(([toolUseId, call]) => [
        toolUseId,
        String(call.input.description ?? call.input.command ?? call.tool),
      ]),
    );
  }
  get lastPreview(): string { return this._lastAssistantText; }
  getSessionId(): string | null { return this.sessionId; }
  getCwd(): string { return this.cwd; }
  getAccumulatedBashOutput(): string | null { return null; }
  getActiveToolCall(): { toolUseId: string; name: string } | null {
    if (!this._isRunning) return null;
    const last = [...this.activeToolCalls.entries()].pop();
    return last ? { toolUseId: last[0], name: last[1].tool } : null;
  }
  getDelegatedLiveActivity(): DelegatedAgentLiveActivity {
    const text = this.textStream;
    const tools = [...this.activeToolCalls.entries()].slice(-10)
      .map(([toolUseId, call]) => ({ tool_use_id: toolUseId, tool: call.tool, input: call.input }));
    return {
      running: this.isBusy,
      ...(text ? { assistant_text: [{ stream_id: text.id, content: text.content.slice(-6_000) }] } : {}),
      ...(tools.length > 0 ? { active_tools: tools } : {}),
      ...(this.thoughtStream ? { reasoning: { in_progress: true } } : {}),
    };
  }
  getAgentSettings(): AgentSessionSettings {
    return {
      ...(this._model ? { model: this._model } : {}),
      effort: this._effort,
      disallowedTools: [...this._disallowedTools],
      additionalDirectories: [...this._additionalDirectories],
      ...(this._systemPromptOverride !== undefined ? { systemPrompt: this._systemPromptOverride } : {}),
    };
  }
  getSessionContext(): SessionContext {
    return {
      sessionId: this.sessionId ?? "",
      cwd: this.cwd,
      send: (msg) => this.send(msg),
      appendHistory: (entry: HistoryEntry) => {
        if (this.sessionId) appendHistory(this.sessionId, entry);
      },
      pendingQuestions: this.pendingQuestions,
      questionCounter: { next: () => createInteractiveRequestId("q") },
    };
  }

  // ─── Settings the app changes ─────────────────────────────────────

  /** Picks a model family, such as gemini-4-neon. agy applies it from the next turn. */
  async setModel(model?: string): Promise<void> {
    const previous = this._model;
    this._model = model ?? null;
    this.normalizeEffort();
    this.persistAgentSettings({ model: this._model || undefined, effort: this._effort });
    const change = recordModelChange(this.sessionId || this._resumeSessionId, previous, model, this._lastSupportedModels?.models ?? []);
    if (change) this.send(change);
    this.publishSupportedModels();
    if (!this._isRunning) await this.applyConfig().catch(() => {});
  }

  /**
   * SocketAgent's modes on agy's. Plan and accept-edits are agy modes;
   * Yolo modes keep agy asking, and SocketAgent answers yes after the
   * protected-file check, the way it does for Codex.
   */
  async setPermissionMode(mode: string, options: { recordHistory?: boolean } = {}): Promise<void> {
    const previous = this._permissionMode;
    this._permissionMode = mode;
    if (this.sessionId) {
      const record = getSession(this.sessionId);
      if (record) saveSession({ ...record, permissionMode: mode });
      if (options.recordHistory !== false && previous !== mode) {
        appendHistory(this.sessionId, { role: "permission_mode", content: "", permissionMode: mode, timestamp: now() });
      }
    }
    if (!this._isRunning) await this.applyConfig().catch(() => {});
  }

  setEffort(e: string): void {
    if (!isEffort(e)) return;
    this._effort = e;
    this.persistAgentSettings({ effort: e });
  }
  setThinking(_t: unknown): void {}
  setSandbox(_mode: unknown): void {}
  setDisallowedTools(tools: string[]): void {
    this._disallowedTools = [...tools];
    this.persistAgentSettings({ disallowedTools: this._disallowedTools });
  }
  setAdditionalDirectories(directories: string[]): void {
    const changed = JSON.stringify(this._additionalDirectories) !== JSON.stringify(directories);
    this._additionalDirectories = [...directories];
    this.persistAgentSettings({ additionalDirectories: this._additionalDirectories });
    // Re-open the ACP session on the next turn so agy picks up updated extra folders.
    if (changed && this.openSessionId && !this._isRunning) {
      this.openSessionId = null;
    }
  }
  setAppendSystemPrompt(s: string, options: { inherited?: boolean; clearOverride?: boolean } = {}): void {
    this._appendSystemPrompt = s;
    if (options.clearOverride) {
      this._systemPromptOverride = undefined;
      this.persistAgentSettings({ systemPrompt: undefined });
    } else if (!options.inherited) {
      this._systemPromptOverride = s;
      this.persistAgentSettings({ systemPrompt: s });
    }
  }
  setPendingTransferContext(context: string): void {
    this._pendingTransferContext = context.trim() || null;
  }
  setResumeSessionAt(_uuid: string): void {}
  setTtsEnabled(b: boolean): void { this._ttsEnabled = b; }
  setTtsEngine(e: string): void {
    if (e === "system" || e === "kokoro_server" || e === "kokoro_device") this._ttsEngine = e;
  }
  setKokoroVoice(v: string): void { this._kokoroVoice = v; }
  setKokoroSpeed(s: number): void { this._kokoroSpeed = s; }
  submitAuthCode(_code: string): void {}

  private persistAgentSettings(patch: Partial<AgentSessionSettings>): void {
    const sid = this.sessionId || this._resumeSessionId;
    if (sid) updateSessionAgentSettings(sid, patch);
  }

  // ─── Clients ──────────────────────────────────────────────────────

  setWebSocket(ws: ClientTransport, deferLiveReplay = false): void {
    this.ws = ws;
    this.clientSockets.add(ws);
    if (this._lastSupportedModels) this.sendTo(ws, this._lastSupportedModels);
    if (this._lastSupportedCommands) this.sendTo(ws, this._lastSupportedCommands);
    if (this.backgroundToolCalls.size > 0) this.emitBackgroundTasksChanged(ws);
    if (!deferLiveReplay) this.sessionEventDelivery.replayTo((message) => this.sendTo(ws, message));
  }

  detachWebSocket(): void {
    // Sockets leave when they close; the app filters by sessionId.
  }

  acknowledgeSessionEvent(deliveryId: string): boolean {
    return this.sessionEventDelivery.acknowledge(deliveryId);
  }

  /** Sends a client that attaches mid-turn what is on screen now. */
  replayLiveState(ws: ClientTransport = this.ws): void {
    const sid = this.sessionId;
    if (!sid) return;
    this.sessionEventDelivery.replayTo((message) => this.sendTo(ws, message));
    for (const [toolUseId, call] of this.activeToolCalls) {
      if (this.sessionEventDelivery.hasPending("tool_call", toolUseId)) continue;
      this.sendTo(ws, { type: "tool_call", tool: call.tool, input: call.input, toolUseId, sessionId: sid, replay: true });
    }
    if (this.backgroundToolCalls.size > 0) this.emitBackgroundTasksChanged(ws);
    if (this.thoughtStream) {
      this.sendTo(ws, { type: "thinking", content: this.thoughtStream.content, sessionId: sid, streamId: this.thoughtStream.id, replay: true });
    }
    if (this.textStream) {
      this.sendTo(ws, { type: "text", content: this.textStream.content, sessionId: sid, streamId: this.textStream.id, replay: true });
    }
    for (const pendingSecureInput of pendingSecureInputMessagesForSession(sid)) this.sendTo(ws, pendingSecureInput);
    for (const pending of this.pendingQuestions.values()) {
      if (pending.questionData) this.sendTo(ws, pending.questionData);
    }
  }

  public send(msg: ServerMessage): void {
    if (msg.type === "error" && !this.connectionChecked.has(msg) && isBackendConnectionError(msg.message)) {
      this.connectionChecked.add(msg);
      void this.connectionFailures.report().then((covered) => {
        if (!covered) this.send(msg);
      });
      return;
    }
    if (msg.type === "question") this.onQuestionAsked?.(msg);
    if (msg.type === "error") {
      try {
        recordSessionError(msg.sessionId || this.sessionId || "", msg);
      } catch (error: unknown) {
        console.error("[History] Could not save session error:", error);
      }
    }
    positionSessionMessage(String(("sessionId" in msg ? msg.sessionId : undefined) || this.sessionId || ""), msg);
    maybeSendAgentAttentionPush(msg, path.basename(this.cwd) || "SocketAgent");
    if ((msg.type === "text" || msg.type === "thinking") && msg.streamId) {
      const key = `${msg.type}:${msg.streamId}`;
      if (msg.snapshot === true && msg.finalSnapshot !== true) {
        this.streamSnapshots.push(key, msg);
        return;
      }
      if (msg.finalSnapshot === true) this.streamSnapshots.discard(key);
    } else if (msg.type === "tool_call") {
      this.streamSnapshots.flushAll();
    }
    this.sendImmediately(msg);
  }

  private sendTo(ws: ClientTransport, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(redactSecretsDeep(msg)));
  }

  private sendImmediately(msg: ServerMessage): void {
    const deliveryAware = [...this.clientSockets].some(
      (socket) => "supportsSessionEventAck" in socket && socket.supportsSessionEventAck === true,
    );
    this.dispatchToClients(deliveryAware && msg.type !== "monitor_output" ? this.sessionEventDelivery.prepare(msg) : msg);
  }

  private dispatchToClients(msg: ServerMessage): void {
    const payload = JSON.stringify(redactSecretsDeep(msg));
    for (const socket of [...this.clientSockets]) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      else if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) this.clientSockets.delete(socket);
    }
  }

  // ─── Questions ────────────────────────────────────────────────────

  pendingQuestion(questionId: string): QuestionServerMessage | undefined {
    const data = this.pendingQuestions.get(questionId)?.questionData;
    return data?.type === "question" ? data : undefined;
  }

  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    this.pendingQuestions.delete(questionId);
    pending.resolve(answers);
    const sid = this.sessionId || this._resumeSessionId;
    if (sid) markQuestionAnswered(sid, questionId, answers);
    return true;
  }

  private cancelPendingQuestions(): void {
    for (const pending of [...this.pendingQuestions.values()]) {
      if (pending.cancel) pending.cancel();
      else {
        this.pendingQuestions.delete(pending.questionId);
        pending.resolve({});
      }
    }
  }

  // ─── Turns ────────────────────────────────────────────────────────

  /** Runs one turn: a new agy session on the first call, the same one after that. */
  async runQuery(prompt: string, resumeSessionId?: string, clientMessageId?: string): Promise<void> {
    if (this._isRunning) throw new Error("This Gemini session is already running a turn");
    if (this._outOfTurnRunning) this.finishOutOfTurnRun(false);
    const previousClientMessageId = this._currentClientMessageId;
    if (clientMessageId !== undefined) this._currentClientMessageId = clientMessageId || null;
    this.connectionFailures.reset();
    this.onBeforeRun?.(resumeSessionId);
    this.clearIdleTimer();
    this._isRunning = true;
    this._runStartedAt = now();
    this._abortRequested = false;
    this._lastAssistantText = "";
    this._currentPrompt = prompt;
    this.onActivity?.();
    if (this.replacesSessionId && !resumeSessionId) {
      // A cleared chat: forget the old agy session, even on a reused object.
      this.sessionId = null;
      this.openSessionId = null;
      this._resumeSessionId = undefined;
      this._lastContextUsed = 0;
    }
    const resumeTarget = resumeSessionId || this._resumeSessionId;
    if (!this.sessionId && resumeTarget) this.sessionId = resumeTarget;
    try {
      const sessionId = await this.openSession();
      this.throwIfAborted();
      this.send({
        type: "session_state_changed",
        state: "running",
        sessionId,
        ...(this._runStartedAt ? { activeStartedAt: this._runStartedAt } : {}),
      });
      const userUuid = this._currentClientMessageId || crypto.randomUUID();
      this.send(recordUserPrompt({
        sessionId,
        content: prompt,
        uuid: userUuid,
        clientMessageId: this._currentClientMessageId || undefined,
        timestamp: now(),
      }));
      await this.applyConfig();
      const blocks = await this.promptBlocks(sessionId, prompt);
      this.throwIfAborted();
      let currentPromise = this.startSessionPrompt(sessionId, blocks);
      this.flushPendingSteers();
      let result: ReturnType<typeof acpPromptResultSchema.parse>;
      while (true) {
        const generation = this._activePromptGeneration;
        const rawResult = await currentPromise;
        if (this._steerDispatchPromise) await this._steerDispatchPromise;
        // Mid-turn steering sends a new session/prompt on the same session; agy
        // immediately resolves the superseded prompt and transfers turn ownership
        // to the steering prompt. Keep awaiting the newest prompt before ending.
        if (this._activePromptGeneration !== generation && this._activePromptPromise) {
          currentPromise = this._activePromptPromise;
          continue;
        }
        result = acpPromptResultSchema.parse(rawResult);
        break;
      }
      this.finishStreams();
      if (result.stopReason === "cancelled") {
        this.settleToolCalls("(interrupted)");
      } else if (this.activeToolCalls.size > 0) {
        // agy keeps backgrounded run_command calls in_progress after ending the
        // turn; promote them to background tasks so the app shows BG + Waiting.
        this.promoteActiveToolsToBackground();
      }
      const usage = this.usageFrom(result.usage);
      if (usage) {
        this._lastUsage = usage;
        this.send({ type: "usage_update", sessionId, ...usage });
      }
      this.send({
        type: "result",
        content: this._abortRequested ? "(interrupted)" : this._lastAssistantText,
        sessionId,
        stopReason: result.stopReason,
        ...(usage ? { usage } : {}),
      });
      updateSessionActivity(sessionId, this._lastAssistantText, usage ?? undefined);
    } catch (error: unknown) {
      this.rejectPendingSteers(error instanceof Error ? error : new Error(String(error)));
      this.finishStreams();
      this.settleToolCalls("(failed)");
      if (!this._abortRequested) {
        this.reportTurnError(error);
        // index.ts skips its own error card for errors a session already showed.
        if (error instanceof Error) Object.assign(error, { socketAgentSurfaced: true });
      }
      throw error;
    } finally {
      if (clientMessageId !== undefined) this._currentClientMessageId = previousClientMessageId;
      this.clearAbortKillTimer();
      this._activePromptPromise = null;
      this._steerDispatchPromise = null;
      this.rejectPendingSteers(new Error("Gemini turn ended before message was steered"));
      this._isRunning = false;
      this._runStartedAt = null;
      if (this.sessionId) {
        this.send({ type: "session_state_changed", state: "idle", sessionId: this.sessionId });
      }
      this.onActivity?.();
      this.runNextQueuedPrompt();
      this.scheduleIdleStop();
    }
  }

  private startSessionPrompt(sessionId: string, prompt: AcpContentBlock[]): Promise<unknown> {
    const previous = this._activePromptPromise;
    if (previous) void previous.catch(() => {});
    this._activePromptGeneration++;
    const next = this.client!.request("session/prompt", { sessionId, prompt }, 0);
    this._activePromptPromise = next;
    return next;
  }

  /**
   * Steers a running turn at the next safe step via ACP's concurrent
   * `session/prompt`, or queues for after the turn when `priority === "later"`.
   */
  async injectMessage(text: string, priority: "now" | "next" | "later" = "now", messageId?: string, _options: object = {}): Promise<void> {
    if (!this._isRunning) {
      if (this._outOfTurnRunning) this.finishOutOfTurnRun(false);
      return this.runQuery(text, undefined, messageId ?? "");
    }
    if (priority === "later") {
      return new Promise((resolve, reject) => {
        this._queuedPrompts.push({ text, messageId, resolve, reject });
        this.onActivity?.();
      });
    }
    return new Promise((resolve, reject) => {
      this._pendingSteers.push({ text, messageId, resolve, reject });
      this.onActivity?.();
      this.flushPendingSteers();
    });
  }

  private flushPendingSteers(): void {
    if (this._steerDispatchPromise || this._pendingSteers.length === 0) return;
    if (!this._isRunning || this._abortRequested || !this.client || !this.openSessionId || !this._activePromptPromise) return;
    this._steerDispatchPromise = this.drainPendingSteers().finally(() => {
      this._steerDispatchPromise = null;
      if (this._pendingSteers.length > 0) this.flushPendingSteers();
    });
  }

  private async drainPendingSteers(): Promise<void> {
    while (this._pendingSteers.length > 0) {
      if (!this._isRunning || this._abortRequested || !this.client || !this.openSessionId) return;
      const steer = this._pendingSteers.shift()!;
      const sessionId = this.openSessionId;
      try {
        this.finishStreams();
        this._currentPrompt = steer.text;
        const userUuid = steer.messageId || crypto.randomUUID();
        this.send(recordUserPrompt({
          sessionId,
          content: steer.text,
          uuid: userUuid,
          clientMessageId: steer.messageId || undefined,
          timestamp: now(),
        }));
        const blocks = await this.promptBlocks(sessionId, steer.text);
        if (!this._isRunning || this._abortRequested || !this.client || !this.openSessionId) {
          steer.reject(new Error("Gemini turn interrupted"));
          return;
        }
        this.startSessionPrompt(sessionId, blocks);
        steer.resolve();
      } catch (error: unknown) {
        steer.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private rejectPendingSteers(error: Error): void {
    for (const steer of this._pendingSteers.splice(0)) steer.reject(error);
  }

  retractQueuedPrompt(messageId: string): string | null {
    if (!messageId) return null;
    for (const queue of [this._queuedPrompts, this._pendingSteers]) {
      const index = queue.findIndex((prompt) => prompt.messageId === messageId);
      if (index < 0) continue;
      const [prompt] = queue.splice(index, 1);
      prompt.reject(new Error("Queued prompt retracted"));
      return prompt.text;
    }
    return null;
  }

  private runNextQueuedPrompt(): void {
    const next = this._queuedPrompts.shift();
    if (!next) return;
    this.runQuery(next.text, undefined, next.messageId ?? "").then(next.resolve, next.reject);
  }

  interrupt(): void { void this.abort(); }

  async abort(): Promise<void> {
    this._abortRequested = true;
    this.cancelPendingQuestions();
    this.rejectPendingSteers(new Error("Gemini turn interrupted"));
    for (const prompt of this._queuedPrompts.splice(0)) prompt.reject(new Error("Gemini turn interrupted"));
    // ACP has no call that stops one background command, and session/cancel
    // leaves them running, so stopping them means stopping agy. The same
    // goes for a turn still waiting on agy to start or open its session.
    const stopProcess = this.backgroundToolCalls.size > 0 || (this._isRunning && (!this.client || !this.openSessionId));
    const sid = this.sessionId || this._resumeSessionId || "";
    if (sid) await stopAppMonitorsForSession(sid);
    if (this._outOfTurnRunning) this.finishOutOfTurnRun(false);
    if (stopProcess || !this.client || !this.openSessionId) {
      await this.stopClient();
      return;
    }
    this.client.notify("session/cancel", { sessionId: this.openSessionId });
    if (!this._isRunning) return;
    // agy answers the prompt with stopReason "cancelled". If it does not
    // within a few seconds, stopping the process ends the turn. The turn's
    // finally clears this timer, so it never reaches the next turn.
    this.clearAbortKillTimer();
    this.abortKillTimer = setTimeout(() => {
      this.abortKillTimer = null;
      if (this._isRunning) void this.stopClient();
    }, this.abortKillMs);
    this.abortKillTimer.unref?.();
  }

  private clearAbortKillTimer(): void {
    if (this.abortKillTimer) clearTimeout(this.abortKillTimer);
    this.abortKillTimer = null;
  }

  private throwIfAborted(): void {
    if (this._abortRequested) throw new Error("Gemini turn interrupted");
  }

  stopMonitoring(taskId: string): void { stopAppMonitor(taskId, true, true); }

  /** agy cannot stop one command, so this stops agy, which ends all of its background commands. */
  async stopTask(taskId: string): Promise<void> {
    if (!this.backgroundToolCalls.has(taskId)) return;
    if (this._isRunning) {
      const sid = this.sessionId || this._resumeSessionId;
      this.send({
        type: "error",
        message: "Gemini can stop its background commands only between turns. Stop the turn to end them now.",
        ...(sid ? { sessionId: sid } : {}),
      });
      return;
    }
    await this.stopClient();
  }
  refreshBackgroundTerminals(): void {}

  async dispose(): Promise<void> {
    this.cancelPendingQuestions();
    this.streamSnapshots.dispose(true);
    await this.stopClient();
  }

  async closeWarmIdle(): Promise<void> {
    if (this.isWarmIdle) await this.stopClient();
  }

  // ─── agy process and ACP session ──────────────────────────────────

  private async ensureClient(): Promise<AcpClient> {
    if (this.client?.isRunning) return this.client;
    const command = resolveAgyCommand();
    if (!command) throw new Error("The Antigravity CLI is not installed on this computer. Install Gemini from the computer's settings in SocketAgent.");
    const client = new AcpClient({ command, args: ["acp", "--disable-telemetry"], cwd: this.cwd });
    client.on("notification", (note: AcpNotification) => this.handleNotification(note));
    client.on("request", (method: string, params: unknown, respond: AcpResponder) => {
      void this.handleRequest(method, params, respond);
    });
    client.on("error", () => { /* The pending request rejects with the cause. */ });
    client.on("exit", () => {
      if (this.client !== client) return;
      this.handleClientExit();
    });
    this.client = client;
    await client.initialize();
    return client;
  }

  /**
   * agy died on its own. A running turn fails through its rejected prompt;
   * everything that lives outside a turn is settled here.
   */
  private handleClientExit(): void {
    this.client = null;
    this.openSessionId = null;
    this.mcpRegistration?.unregister();
    this.mcpRegistration = null;
    this.cancelPendingQuestions();
    if (!this._isRunning) this.settleToolCalls("(agy exited)");
    this.clearBackgroundToolCalls("failed", "(agy exited)");
    if (this._outOfTurnRunning) this.finishOutOfTurnRun(false);
  }

  private async stopClient(): Promise<void> {
    this.clearIdleTimer();
    this.clearOutOfTurnIdleTimer();
    this.clearBackgroundToolCalls("stopped", "(stopped)");
    if (this._outOfTurnRunning) this.finishOutOfTurnRun(false);
    const client = this.client;
    this.client = null;
    this.openSessionId = null;
    this.mcpRegistration?.unregister();
    this.mcpRegistration = null;
    await client?.stop();
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.client) return;
      if (this.isBusy) this.scheduleIdleStop();
      else void this.stopClient();
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private mcpServers() {
    if (!this.mcpRegistration) {
      this.boardTools = boardToolset(this.sessionId || this._resumeSessionId || "", this.projectBoardHint);
      this.mcpRegistration = registerCodexAppMcp(this.createAppToolContext(), this.boardTools);
    }
    const port = process.env.PORT || "8085";
    return [{
      type: "http" as const,
      name: MCP_SERVER_NAME,
      url: `http://127.0.0.1:${port}/codex-mcp/${encodeURIComponent(this.mcpRegistration.token)}`,
      headers: [],
    }];
  }

  /** Opens the chat's agy session in this process and returns its ID. */
  private async openSession(): Promise<string> {
    const client = await this.ensureClient();
    if (this.openSessionId) return this.openSessionId;
    const meta = { antigravity: { systemPrompt: { append: this.instructions() } } };
    const extraDirs = this._additionalDirectories.length > 0
      ? { additionalDirectories: [...this._additionalDirectories] }
      : {};
    const existing = this.sessionId;
    try {
      const raw = existing
        ? await client.request("session/resume", { sessionId: existing, cwd: this.cwd, mcpServers: this.mcpServers(), ...extraDirs, _meta: meta })
        : await client.request("session/new", { cwd: this.cwd, mcpServers: this.mcpServers(), ...extraDirs, _meta: meta });
      const setup = acpSessionSetupSchema.parse(raw);
      const sessionId = existing || setup.sessionId;
      if (!sessionId) throw new Error("agy did not return a session ID");
      this.openSessionId = sessionId;
      this.configOptions = setup.configOptions ?? [];
      this.availableModelIds = setup.models?.availableModels.map((model) => model.modelId) ?? [];
      if (!existing) this.recordNewSession(sessionId);
      this.publishSupportedModels();
      if (this._lastSupportedCommands) {
        this._lastSupportedCommands = { ...this._lastSupportedCommands, sessionId };
        this.send(this._lastSupportedCommands);
      }
      return sessionId;
    } catch (error: unknown) {
      if (error instanceof AcpError && error.code === ACP_AUTH_REQUIRED) {
        this.send({
          type: "backend_auth_required",
          backend: "gemini",
          sessionId: this.sessionId || undefined,
          message: "Sign in to Google to use Gemini on this computer.",
          detail: error.message,
        });
      }
      throw error;
    }
  }

  /**
   * Saves a new agy session. After a cleared context, [replacesSessionId] is
   * the visible chat: its history and list entry move to the new ID, like
   * Claude and Codex do.
   */
  private recordNewSession(sessionId: string): void {
    this.sessionId = sessionId;
    const replacesSessionId = this.replacesSessionId;
    this.replacesSessionId = undefined;
    const info: SessionInfo = {
      id: sessionId,
      title: promptTitle(this._currentPrompt),
      cwd: this.cwd,
      createdAt: now(),
      lastActive: now(),
      messagePreview: "",
      backend: "gemini",
      ...(this.sessionLifetime === "fleeting" ? { lifetime: "fleeting" as const } : {}),
      ...(this._delegationSupervisorSessionId ? { delegationSupervisorSessionId: this._delegationSupervisorSessionId } : {}),
      permissionMode: this._permissionMode,
      agentSettings: this.getAgentSettings(),
    };
    if (replacesSessionId && replacesSessionId !== sessionId) {
      remapSession(replacesSessionId, sessionId);
      remapSessionMemory(replacesSessionId, sessionId);
      const remapped = getSession(sessionId);
      saveSession({ ...info, ...remapped, id: sessionId, backend: "gemini", messagePreview: "", permissionMode: this._permissionMode, agentSettings: this.getAgentSettings() });
      this.onSessionIdChanged?.(replacesSessionId, sessionId);
    } else {
      saveSession(info);
    }
    const saved = getSession(sessionId);
    this.send({
      type: "session_created",
      sessionId,
      cwd: this.cwd,
      title: saved?.title ?? info.title,
      backend: "gemini",
      permissionMode: this._permissionMode,
      ...(replacesSessionId ? { replacesSessionId } : {}),
    });
    this.send({ type: "session_settings", sessionId, settings: this.getAgentSettings() });
  }

  /** Applies the chosen model, thinking level and mode when they differ from agy's. */
  private async applyConfig(): Promise<void> {
    const client = this.client;
    const sessionId = this.openSessionId;
    if (!client || !sessionId) return;
    const option = (id: string) => this.configOptions.find((entry) => entry.id === id);
    const set = async (id: string, value: string) => {
      const current = option(id);
      if (!current || current.currentValue === value) return;
      if (!selectValues(current).some((entry) => entry.value === value)) return;
      const raw = await client.request("session/set_config_option", { sessionId, configId: id, value });
      const parsed = acpSessionSetupSchema.safeParse(raw);
      if (parsed.success && parsed.data.configOptions) this.configOptions = parsed.data.configOptions;
    };
    if (this._model) await set("model", this._model);
    await set("thought_level", this._effort);
    const mode = this._permissionMode === "plan" ? "plan" : this._permissionMode === "acceptEdits" ? "accept-edits" : "default";
    await set("mode", mode);
  }

  private async promptBlocks(sessionId: string, prompt: string): Promise<AcpContentBlock[]> {
    const blocks: AcpContentBlock[] = [];
    try {
      const board = await prepareBoardTurn(sessionId, this.projectBoardHint, null);
      if (board.block) blocks.push({ type: "text", text: board.block });
      commitBoardTurn(sessionId, board.digest);
    } catch (error: unknown) {
      console.warn(`[Gemini] Could not prepare the project board block: ${error instanceof Error ? error.message : String(error)}`);
    }
    const handoff = this._pendingTransferContext;
    this._pendingTransferContext = null;
    blocks.push({
      type: "text",
      text: handoff
        ? `<socketagent_session_handoff>\n${handoff}\n</socketagent_session_handoff>\n\nCurrent user message:\n${prompt}`
        : prompt,
    });
    blocks.push(...extractAttachedImageBlocks(prompt));
    return blocks;
  }

  /** SocketAgent's instructions, appended to agy's own system prompt. */
  private instructions(): string {
    const parts = [buildSocketAgentIntegrationInstructions({
      mcpServerName: MCP_SERVER_NAME,
      toolNames: socketAgentAppToolNames(this.boardTools ?? boardToolset(this.sessionId || "", this.projectBoardHint)),
      secureInventory: secureInputInventoryForAgent(this.sessionId || undefined, this.cwd),
      discoverMissingTools: true,
    })];
    for (const plugin of this._plugins) {
      const fragment = plugin.toolContextFragment?.();
      if (fragment) parts.push(fragment);
    }
    if (this._ttsEnabled) {
      parts.push("Text-to-speech is enabled. Before your final text response, call the Speak tool once with a short spoken summary. Do not read code, URLs, or markdown aloud. Always still write your full text response.");
    }
    const append = this._appendSystemPrompt.trim();
    if (append) parts.push(append);
    return parts.join("\n\n");
  }

  private createAppToolContext(): AppToolContext {
    return {
      getProjectBoardHint: () => this.projectBoardHint,
      getSessionId: () => this.sessionId || "",
      getDelegationSupervisorSessionId: () => String(
        this._delegationSupervisorSessionId || getSession(this.sessionId || "")?.delegationSupervisorSessionId || this.sessionId || "",
      ),
      getCwd: () => this.cwd,
      getBackend: () => "gemini",
      send: (msg) => this.send(msg),
      appendHistory: (entry) => {
        if (this.sessionId) return appendHistory(this.sessionId, entry);
      },
      getTtsEngine: () => this._ttsEngine,
      getKokoroVoice: () => this._kokoroVoice,
      getKokoroSpeed: () => this._kokoroSpeed,
      isRunning: () => this.isRunning,
      injectMessage: (text, priority) => this.injectMessage(text, priority),
      onMonitorOutput: (text) => {
        if (!this.onMonitorOutput) return false;
        this.onMonitorOutput(text);
        return true;
      },
      manageAgentSession: (args) => {
        if (!this.onAgentSessionRequest) throw new Error("AgentSession runtime is not attached");
        return this.onAgentSessionRequest(args);
      },
      manageComputers: (args, signal) => {
        if (!this.onComputersRequest) throw new Error("Computers runtime is not attached");
        return this.onComputersRequest(args, signal);
      },
      requestTranscriptAccess: (detail) => this._abortRequested ? Promise.resolve(false) : requestTranscriptAccess(this.getSessionContext(), detail),
      requestPluginAuthorization: async (pluginName) => {
        const plugin = this._plugins.find((candidate) => candidate.name === pluginName);
        if (!plugin?.requestAuthorization) throw new Error(`Private integration is not available: ${pluginName}`);
        return await plugin.requestAuthorization(this.getSessionContext());
      },
    };
  }

  // ─── What agy streams ─────────────────────────────────────────────

  private handleNotification(note: AcpNotification): void {
    if (note.method !== "session/update" || !isRecord(note.params) || !isRecord(note.params.update)) return;
    const update = note.params.update;
    // agy can send available_commands_update in the same stdout chunk as the
    // session/new response, before openSession() finishes its await microtask.
    if (update.sessionUpdate === "available_commands_update") {
      const targetSid = typeof note.params.sessionId === "string" ? note.params.sessionId : "";
      if (this.openSessionId && targetSid !== this.openSessionId) return;
      const commands = unknownArray(update.availableCommands).flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) return [];
        const description = typeof entry.description === "string" ? entry.description : "";
        const input = isRecord(entry.input) && typeof entry.input.hint === "string" ? entry.input.hint : undefined;
        return [{
          name: entry.name.trim(),
          description,
          ...(input ? { argumentHint: input } : {}),
          kind: "command",
          agent: "gemini",
        }];
      });
      const message: SupportedCommandsServerMessage = {
        type: "supported_commands",
        commands,
        sessionId: this.sessionId || targetSid,
      };
      this._lastSupportedCommands = message;
      if (this.sessionId) this.send(message);
      return;
    }
    const sid = this.sessionId;
    if (!sid || note.params.sessionId !== this.openSessionId) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = isRecord(update.content) && update.content.type === "text" && typeof update.content.text === "string"
          ? update.content.text : "";
        if (!content) return;
        if (!this._isRunning) this.beginOutOfTurnRun(sid);
        // agy normally ends out-of-turn output with a usage_update. If one
        // never comes, the run still ends once agy goes quiet.
        if (this._outOfTurnRunning) this.scheduleOutOfTurnFinish(OUT_OF_TURN_STALL_MS);
        else this.clearOutOfTurnIdleTimer();
        // If agy returned control to the model while a tool is still in_progress,
        // that tool was moved to the background (e.g. run_command WaitMsBeforeAsync).
        if (this.activeToolCalls.size > 0) this.promoteActiveToolsToBackground();
        const thought = update.sessionUpdate === "agent_thought_chunk";
        if (thought) {
          const stream = this.thoughtStream ?? { id: crypto.randomUUID(), content: "", startedAtMs: Date.now() };
          stream.content += content;
          this.thoughtStream = stream;
          this.send({ type: "thinking", content: stream.content, sessionId: sid, streamId: stream.id, snapshot: true });
        } else {
          this.finishThought();
          const stream = this.textStream ?? { id: crypto.randomUUID(), content: "" };
          stream.content += content;
          this.textStream = stream;
          this.send({ type: "text", content: stream.content, sessionId: sid, streamId: stream.id, snapshot: true });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const toolUseId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (!toolUseId) return;
        const isTerminal = update.status === "completed" || update.status === "failed";
        if (!this.activeToolCalls.has(toolUseId) && !this.backgroundToolCalls.has(toolUseId) && !isTerminal) {
          if (!this._isRunning) this.beginOutOfTurnRun(sid);
          this.clearOutOfTurnIdleTimer();
          this.finishStreams();
          const normalized = normalizeGeminiToolCall(update);
          const call: ActiveToolCall = {
            tool: normalized.tool,
            input: normalized.input,
            lastStreamedOutput: "",
            streamChunkIndex: 0,
          };
          this.activeToolCalls.set(toolUseId, call);
          this.send({ type: "tool_call", tool: call.tool, input: call.input, toolUseId, sessionId: sid });
          appendHistory(sid, {
            role: "tool_call",
            content: String(call.input.description ?? call.input.command ?? call.input.file_path ?? call.tool),
            toolName: call.tool,
            toolInput: call.input,
            toolUseId,
            timestamp: now(),
          });
        } else if (!isTerminal) {
          const active = this.activeToolCalls.get(toolUseId) ?? this.backgroundToolCalls.get(toolUseId);
          if (active) {
            const partial = toolOutputText(update);
            if (partial && partial !== active.lastStreamedOutput) {
              if (partial.startsWith(active.lastStreamedOutput)) {
                const delta = partial.slice(active.lastStreamedOutput.length);
                if (delta) {
                  this.send({
                    type: "tool_result_chunk",
                    toolUseId,
                    content: delta,
                    chunkIndex: active.streamChunkIndex++,
                    done: false,
                    sessionId: sid,
                  });
                }
              } else {
                this.send({
                  type: "tool_result_chunk",
                  toolUseId,
                  content: partial,
                  chunkIndex: 0,
                  done: false,
                  sessionId: sid,
                });
                active.streamChunkIndex = 1;
              }
              active.lastStreamedOutput = partial;
            }
          }
        }
        if (isTerminal) {
          const wasActive = this.activeToolCalls.delete(toolUseId);
          const bgCall = wasActive ? undefined : this.backgroundToolCalls.get(toolUseId);
          if (!wasActive && !bgCall) return;
          if (bgCall) this.backgroundToolCalls.delete(toolUseId);
          const output = toolOutputText(update) || (update.status === "failed" ? (this._abortRequested ? "(interrupted)" : "(failed)") : "(completed)");
          this.send({ type: "tool_result", toolUseId, output, sessionId: sid });
          appendHistory(sid, { role: "tool_result", content: output, toolUseId, toolOutput: output, timestamp: now() });
          if (bgCall) {
            const status = update.status === "failed" ? "failed" : "completed";
            const summary = String(bgCall.input.description ?? bgCall.input.command ?? bgCall.tool);
            this.send({
              type: "task_notification",
              taskId: toolUseId,
              status,
              summary,
              originToolUseId: toolUseId,
              sessionId: sid,
            });
            this.emitBackgroundTasksChanged();
            this.onActivity?.();
          }
        }
        return;
      }
      case "usage_update": {
        if (typeof update.size === "number" && update.size > 0) this._contextWindow = update.size;
        if (typeof update.used === "number" && update.used >= 0 && this._contextWindow > 0) {
          const totalTokens = Math.floor(update.used);
          const maxTokens = Math.floor(this._contextWindow);
          this._lastContextUsed = totalTokens;
          const contextUsage: ContextUsage = {
            totalTokens,
            maxTokens,
            remainingTokens: Math.max(0, maxTokens - totalTokens),
            percentUsed: maxTokens > 0 ? totalTokens / maxTokens : 0,
            categories: totalTokens > 0 ? [{ name: "Context", tokens: totalTokens, color: "#A78BFA" }] : [],
          };
          this.send({ type: "context_usage", sessionId: sid, ...contextUsage });
          this.send({
            type: "usage_update",
            sessionId: sid,
            inputTokens: totalTokens,
            outputTokens: this._lastUsage?.outputTokens ?? 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            contextWindow: maxTokens,
          });
          updateSessionContextUsage(sid, contextUsage);
          recordSessionMemoryContextUsage(sid, totalTokens, maxTokens);
        }
        if (this._outOfTurnRunning && this.activeToolCalls.size === 0) {
          this.scheduleOutOfTurnFinish();
        }
        return;
      }
      case "session_info_update": {
        if (typeof update.title !== "string" || !update.title.trim()) return;
        const record = getSession(sid);
        // agy names the chat after its first turn; a title the user set stays.
        if (record && record.title === promptTitle(this._currentPrompt)) {
          saveSession({ ...record, title: update.title.trim() });
          this.onActivity?.();
        }
        return;
      }
      case "config_option_update": {
        const parsed = acpSessionSetupSchema.safeParse(update);
        if (parsed.success && parsed.data.configOptions) this.configOptions = parsed.data.configOptions;
        return;
      }
      default:
        return;
    }
  }

  private finishThought(): void {
    const stream = this.thoughtStream;
    const sid = this.sessionId;
    this.thoughtStream = null;
    if (!stream || !sid) return;
    const thinkingDurationMs = Math.max(1, Date.now() - stream.startedAtMs);
    const timestamp = new Date(stream.startedAtMs).toISOString();
    this.send({
      type: "thinking",
      content: stream.content,
      sessionId: sid,
      streamId: stream.id,
      snapshot: true,
      finalSnapshot: true,
      thinkingDurationMs,
      timestamp,
    });
    appendHistory(sid, {
      role: "assistant",
      content: stream.content,
      thinking: true,
      streamId: stream.id,
      thinkingDurationMs,
      timestamp,
    });
  }

  /** Closes the open thought and message, so the next text starts a new bubble. */
  private finishStreams(): void {
    this.finishThought();
    const stream = this.textStream;
    const sid = this.sessionId;
    this.textStream = null;
    if (!stream || !sid) return;
    this._lastAssistantText = stream.content;
    this.send({ type: "text", content: stream.content, sessionId: sid, streamId: stream.id, snapshot: true, finalSnapshot: true });
    appendHistory(sid, { role: "assistant", content: stream.content, streamId: stream.id, timestamp: now() });
  }

  private settleToolCalls(output: string): void {
    const sid = this.sessionId;
    if (!sid) return;
    for (const toolUseId of this.activeToolCalls.keys()) {
      this.send({ type: "tool_result", toolUseId, output, sessionId: sid });
      appendHistory(sid, { role: "tool_result", content: output, toolUseId, toolOutput: output, timestamp: now() });
    }
    this.activeToolCalls.clear();
  }

  private promoteActiveToolsToBackground(): void {
    if (this.activeToolCalls.size === 0) return;
    for (const [toolUseId, call] of this.activeToolCalls.entries()) {
      this.backgroundToolCalls.set(toolUseId, call);
    }
    this.activeToolCalls.clear();
    this.emitBackgroundTasksChanged();
    this.onActivity?.();
  }

  private clearBackgroundToolCalls(status: "stopped" | "failed", output: string): void {
    if (this.backgroundToolCalls.size === 0) return;
    const sid = this.sessionId;
    const entries = [...this.backgroundToolCalls.entries()];
    this.backgroundToolCalls.clear();
    if (!sid) return;
    for (const [toolUseId, call] of entries) {
      this.send({ type: "tool_result", toolUseId, output, sessionId: sid });
      appendHistory(sid, { role: "tool_result", content: output, toolUseId, toolOutput: output, timestamp: now() });
      this.send({
        type: "task_notification",
        taskId: toolUseId,
        status,
        summary: String(call.input.description ?? call.input.command ?? call.tool),
        originToolUseId: toolUseId,
        sessionId: sid,
      });
    }
    this.emitBackgroundTasksChanged();
    this.onActivity?.();
  }

  private emitBackgroundTasksChanged(ws?: ClientTransport): void {
    const sid = this.sessionId;
    if (!sid) return;
    const message: ServerMessage = {
      type: "background_tasks_changed",
      tasks: [...this.backgroundToolCalls.entries()].map(([toolUseId, call]) => ({
        taskId: toolUseId,
        taskType: call.tool === "Bash" ? "local_bash" : "background",
        description: String(call.input.description ?? call.input.command ?? call.tool),
        toolUseId,
      })),
      sessionId: sid,
    };
    if (ws) this.sendTo(ws, message);
    else this.send(message);
  }

  private beginOutOfTurnRun(sessionId: string): void {
    if (this._outOfTurnRunning) return;
    this.clearIdleTimer();
    this._outOfTurnRunning = true;
    this._runStartedAt = now();
    this._lastAssistantText = "";
    this.send({
      type: "session_state_changed",
      state: "running",
      sessionId,
      activeStartedAt: this._runStartedAt,
    });
    this.onHarnessRunStateChanged?.(true);
    this.onActivity?.();
  }

  private clearOutOfTurnIdleTimer(): void {
    if (this.outOfTurnIdleTimer) clearTimeout(this.outOfTurnIdleTimer);
    this.outOfTurnIdleTimer = null;
  }

  private scheduleOutOfTurnFinish(delayMs = this.outOfTurnSettleMs): void {
    this.clearOutOfTurnIdleTimer();
    this.outOfTurnIdleTimer = setTimeout(() => {
      this.outOfTurnIdleTimer = null;
      if (this._outOfTurnRunning && !this._isRunning && this.activeToolCalls.size === 0) {
        this.finishOutOfTurnRun(true);
      }
    }, delayMs);
    this.outOfTurnIdleTimer.unref?.();
  }

  private finishOutOfTurnRun(emitResult: boolean): void {
    this.clearOutOfTurnIdleTimer();
    if (!this._outOfTurnRunning) return;
    const sid = this.sessionId;
    this.finishStreams();
    if (this.activeToolCalls.size > 0) this.promoteActiveToolsToBackground();
    this._outOfTurnRunning = false;
    this._runStartedAt = null;
    if (sid) {
      if (emitResult) {
        this.send({
          type: "result",
          content: this._lastAssistantText,
          sessionId: sid,
          stopReason: "end_turn",
        });
        updateSessionActivity(sid, this._lastAssistantText);
      }
      this.send({ type: "session_state_changed", state: "idle", sessionId: sid });
    }
    this.onHarnessRunStateChanged?.(false);
    this.onActivity?.();
    this.scheduleIdleStop();
  }

  private usageFrom(raw: unknown): UsageInfo | null {
    if (!isRecord(raw)) return null;
    const count = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? Math.max(0, Math.floor(raw[key])) : 0);
    let inputTokens = count("inputTokens");
    const outputTokens = count("outputTokens") + count("thoughtTokens");
    let cacheReadTokens = count("cachedReadTokens");
    let cacheCreateTokens = count("cachedWriteTokens");
    // ACP session/prompt result.usage sums prompt tokens across every tool step
    // in the turn, inflating input+cache past the actual context window fill.
    // Anchor prompt-side counts to the authoritative usage_update fill so the
    // header meter and context dialog agree.
    const rawPromptTotal = inputTokens + cacheReadTokens + cacheCreateTokens;
    if (this._lastContextUsed > 0 && rawPromptTotal > 0 && rawPromptTotal !== this._lastContextUsed) {
      const scale = this._lastContextUsed / rawPromptTotal;
      cacheReadTokens = Math.floor(cacheReadTokens * scale);
      cacheCreateTokens = Math.floor(cacheCreateTokens * scale);
      inputTokens = Math.max(0, this._lastContextUsed - cacheReadTokens - cacheCreateTokens);
    } else if (this._lastContextUsed > 0 && rawPromptTotal === 0) {
      inputTokens = this._lastContextUsed;
    }
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      contextWindow: this._contextWindow,
    };
  }

  private reportTurnError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const sid = this.sessionId || this._resumeSessionId;
    this.send({ type: "error", message: `Gemini: ${message}`, ...(sid ? { sessionId: sid } : {}) });
  }

  // ─── What agy asks ────────────────────────────────────────────────

  private async handleRequest(method: string, params: unknown, respond: AcpResponder): Promise<void> {
    if (method === "elicitation/create" && isRecord(params)) {
      await this.handleElicitation(params, respond);
      return;
    }
    if (method !== "session/request_permission" || !isRecord(params)) {
      respond({ error: { code: -32601, message: `SocketAgent does not handle ${method}` } });
      return;
    }
    const options = unknownArray(params.options).flatMap((entry) =>
      isRecord(entry) && typeof entry.optionId === "string" && typeof entry.kind === "string"
        ? [{ optionId: entry.optionId, kind: entry.kind }] : []);
    const allow = options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
    const reject = options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind === "reject_always");
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const approved = allow ? await this.approve(toolCall) : false;
    if (approved && allow) respond({ result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    else if (reject && !this._abortRequested) respond({ result: { outcome: { outcome: "selected", optionId: reject.optionId } } });
    else respond({ result: { outcome: { outcome: "cancelled" } } });
  }

  /** Surfaces agy's `ask_question` elicitation form as a native SocketAgent QuestionCard. */
  private async handleElicitation(params: Record<string, unknown>, respond: AcpResponder): Promise<void> {
    if (this._abortRequested) {
      respond({ result: { action: "cancel" } });
      return;
    }
    const fields = parseAcpElicitationQuestions(params);
    if (fields.length === 0) {
      respond({ result: { action: "cancel" } });
      return;
    }
    const questionId = createInteractiveRequestId("gemini_q");
    const sessionId = this.sessionId || this._resumeSessionId || "";
    const questions = fields.map((field) => ({
      question: field.question,
      header: field.header,
      options: field.options.map((opt) => ({
        label: opt.label,
        ...(opt.description ? { description: opt.description } : {}),
      })),
      multiSelect: field.multiSelect,
    }));
    const message: QuestionServerMessage = {
      type: "question",
      questionId,
      sessionId,
      questions,
    };
    if (sessionId) appendHistory(sessionId, { role: "question", content: "", questionId, questions, timestamp: now() });
    const waiting = waitForInteractiveAnswer(this.pendingQuestions, questionId, message, undefined, () => {
      if (sessionId) markQuestionAnswered(sessionId, questionId, {});
      this.send({ type: "question_answered", questionId, sessionId, answers: {} });
    });
    this.send(message);
    const answers = await waiting;
    const content = answers ? buildAcpElicitationContent(fields, answers) : {};
    if (Object.keys(content).length === 0) {
      respond({ result: { action: "cancel" } });
      return;
    }
    respond({ result: { action: "accept", content } });
  }

  private isToolDisallowed(rawName: string, canonicalName: string): boolean {
    if (this._disallowedTools.length === 0) return false;
    const blocked = new Set(this._disallowedTools.map((tool) => tool.trim().toLowerCase()).filter(Boolean));
    return blocked.has(rawName.toLowerCase()) || blocked.has(canonicalName.toLowerCase());
  }

  /** Whether [rawName] is one of the tools on SocketAgent's own MCP server, matched exactly. */
  private isSocketAgentAppTool(rawName: string): boolean {
    const prefix = `mcp_${MCP_SERVER_NAME}_`;
    if (!rawName.startsWith(prefix)) return false;
    const tools = socketAgentAppToolNames(this.boardTools ?? boardToolset(this.sessionId || "", this.projectBoardHint));
    return tools.includes(rawName.slice(prefix.length));
  }

  /** Plugin checks (protected files) first, then the phone, unless a Yolo mode says yes. */
  private async approve(toolCall: Record<string, unknown>): Promise<boolean> {
    if (this._abortRequested) return false;
    const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
    const name = typeof toolCall.name === "string" ? toolCall.name : typeof toolCall.kind === "string" ? toolCall.kind : "tool";
    const normalized = normalizeGeminiToolCall(toolCall);
    if (this.isToolDisallowed(name, normalized.tool)) return false;
    // SocketAgent's own tools ask the phone themselves where it matters, as with Codex.
    if (this.isSocketAgentAppTool(name)) return true;
    const paths = unknownArray(toolCall.locations).flatMap((entry) => isRecord(entry) && typeof entry.path === "string" ? [entry.path] : []);
    const isFileChange = toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move";
    const normalizedPath = typeof normalized.input.file_path === "string" ? normalized.input.file_path : "";
    const changedPaths = [...new Set(normalizedPath ? [...paths, normalizedPath] : paths)];
    // A file change that names no file cannot be checked against protected paths.
    if (isFileChange && changedPaths.length === 0) return false;
    const policyChecks: Array<[string, Record<string, unknown>]> = isFileChange
      ? changedPaths.map((filePath) => ["Edit", { file_path: filePath }])
      : toolCall.kind === "execute"
        ? [["Bash", { command: String(input.CommandLine ?? input.command ?? toolCall.title ?? "") }]]
        : [[normalized.tool, normalized.input]];
    for (const [tool, toolInput] of policyChecks) {
      for (const plugin of this._plugins) {
        const result = await plugin.canUseToolInterceptor?.(tool, toolInput, this.getSessionContext());
        if (result?.behavior === "deny") return false;
      }
    }
    if (this._permissionMode === "bypassPermissions" || this._permissionMode === "superYolo") return true;

    const questionId = createInteractiveRequestId("gemini_approval");
    const sessionId = this.sessionId || this._resumeSessionId || "";
    const question = toolApprovalMarkdown(normalized.tool, {
      ...normalized.input,
      ...(paths.length && !("file_path" in normalized.input) ? { paths } : {}),
    });
    const message: QuestionServerMessage = {
      type: "question",
      questionId,
      sessionId,
      questions: [{ question, header: "Tool approval", options: [{ label: "Approve" }, { label: "Decline" }], multiSelect: false }],
    };
    if (sessionId) appendHistory(sessionId, { role: "question", content: "", questionId, questions: message.questions, timestamp: now() });
    const waiting = waitForInteractiveAnswer(this.pendingQuestions, questionId, message, undefined, () => {
      if (sessionId) markQuestionAnswered(sessionId, questionId, {});
      this.send({ type: "question_answered", questionId, sessionId, answers: {} });
    });
    this.send(message);
    const answers = await waiting;
    return answers?.[question] === "Approve";
  }

  // ─── Models ───────────────────────────────────────────────────────

  /** Lists the model families agy offers this account, with the thinking levels each has. */
  async refreshSupportedModels(force = false): Promise<void> {
    if (this.configOptions.length > 0) {
      this.publishSupportedModels();
      return;
    }
    const cached = getCachedModelCatalog("gemini");
    if (cached) {
      this.publishCatalog(cached.models, { cached: true, updatedAt: cached.updatedAt });
      if (!force && modelCatalogIsFresh(cached)) return;
    }
    try {
      const models = await this.discoverSupportedModels();
      if (models.length === 0 || this.configOptions.length > 0) return;
      const saved = saveCachedModelCatalog("gemini", models);
      this.publishCatalog(saved.models, { updatedAt: saved.updatedAt });
    } catch (error: unknown) {
      console.warn(`[GeminiModels] Failed to discover models before a turn: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected discoverSupportedModels(): Promise<Array<Record<string, unknown>>> {
    return discoverAgyModels();
  }

  private publishSupportedModels(): void {
    const modelOption = this.configOptions.find((entry) => entry.id === "model");
    const families = selectValues(modelOption);
    if (families.length === 0) return;
    const defaultFamily = typeof modelOption?.currentValue === "string" ? modelOption.currentValue : families[0].value;
    const models = families.map((family) => {
      const efforts = this.availableModelIds.flatMap((id) => {
        const suffix = id.startsWith(`${family.value}-`) ? id.slice(family.value.length + 1) : "";
        return isEffort(suffix) ? [{ reasoningEffort: suffix }] : [];
      });
      return {
        id: family.value,
        value: family.value,
        displayName: family.name,
        description: family.description ?? "",
        isDefault: family.value === defaultFamily,
        ...(efforts.length > 0 ? { supportedReasoningEfforts: efforts, supportedEffortLevels: efforts.map((e) => e.reasoningEffort), defaultReasoningEffort: efforts.some((e) => e.reasoningEffort === "high") ? "high" : efforts[efforts.length - 1].reasoningEffort } : {}),
      };
    });
    const saved = saveCachedModelCatalog("gemini", models);
    this.publishCatalog(saved.models, { updatedAt: saved.updatedAt });
  }

  private publishCatalog(models: Array<Record<string, unknown>>, options: { cached?: boolean; updatedAt?: string }): void {
    if (models.length === 0) return;
    if (!this._model) {
      const fallback = models.find((model) => model.isDefault === true) ?? models[0];
      this._model = typeof fallback.value === "string" ? fallback.value : null;
      this.normalizeEffort(models);
      this.persistAgentSettings({ model: this._model || undefined, effort: this._effort });
    }
    const currentModel = this._model || "";
    const message: SupportedModelsServerMessage = {
      type: "supported_models",
      models: models.map((model) => ({ ...model, current: model.value === currentModel })),
      ...(currentModel ? { currentModel } : {}),
      sessionId: this.sessionId || this._resumeSessionId || "",
      backend: "gemini",
      ...(options.cached ? { cached: true } : {}),
      ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
    };
    this._lastSupportedModels = message;
    this.send(message);
  }

  /** Keeps the thinking level one the chosen model has. */
  private normalizeEffort(models: Array<Record<string, unknown>> = this._lastSupportedModels?.models ?? []): void {
    const model = models.find((entry) => entry.value === this._model);
    const efforts = unknownArray(model?.supportedReasoningEfforts).flatMap((entry) =>
      isRecord(entry) && isEffort(entry.reasoningEffort) ? [entry.reasoningEffort] : []);
    if (efforts.length === 0 || efforts.includes(this._effort)) return;
    const fallback = model?.defaultReasoningEffort;
    this._effort = isEffort(fallback) ? fallback : efforts[efforts.length - 1];
  }

  // ─── Features agy does not have ───────────────────────────────────

  async mcpServerStatus(): Promise<McpServerStatusEntry[]> { return []; }
  async reconnectMcpServer(_name: string): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "Gemini manages its own MCP servers. Use agy mcp on the computer." };
  }
  async toggleMcpServer(_name: string, _enabled: boolean): Promise<void> {
    throw new Error("Gemini manages its own MCP servers. Use agy mcp on the computer.");
  }
  async loginMcpServer(_name: string): Promise<void> {
    throw new Error("Gemini manages its own MCP servers. Use agy mcp on the computer.");
  }
  async rewindFiles(_uuid: string, _dryRun = false): Promise<{ success: boolean; restored: string[] }> {
    return { success: false, restored: [] };
  }
}
