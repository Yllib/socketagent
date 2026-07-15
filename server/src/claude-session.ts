import { query, createSdkMcpServer, tool, forkSession as sdkForkSession, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as crypto from "crypto";
import { execFile, execFileSync, spawn, spawnSync } from "child_process";
import * as pty from "node-pty";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";
import {
  ServerMessage,
  ActiveSubagentsServerMessage,
  HistoryEntry,
  QuestionItem,
  SessionInfo,
  AgentSessionSettings,
  Backend,
} from "./protocol";
import { saveSession, getSession, updateSessionActivity, updateSessionContextUsage, updateSessionAgentSettings, appendHistory, saveTodos, getTodos, remapSession, markQuestionAnswered, appendSdkEvent, assignUserUuid, cacheToolImage } from "./session-store";
import { saveScheduledTask, ScheduledTask, RecurrenceConfig } from "./scheduled-task-store";
import { SocketAgentPlugin, SessionContext } from "./plugin-api";
import {
  AppToolContext,
  handleNotifyUserTool,
  handleRequestSecureInputTool,
  handleScheduleReminderTool,
  handleSendFileTool,
  handleSpeakTool,
} from "./app-tool-handlers";
import { SOCKETAGENT_FILE_LINK_INSTRUCTIONS } from "./socketagent-instructions";
import { pendingSecureInputMessagesForSession, redactSecretsDeep, secureInputInventoryForAgent } from "./secure-input-store";
import { SessionEventDelivery } from "./session-event-delivery";
import { legacyManagedNpmBinDir, legacyManagedNpmPrefix, managedNpmBinDir, managedNpmPrefix } from "./socket-agent-paths";
import { createClaudeAuthRequest, exchangeClaudeAuthCode, ClaudeAuthRequest } from "./claude-auth";

export type ClaudeExecutableSource = "explicit" | "sdk" | "managed" | "legacy" | "system" | "unresolved";

export interface ClaudeExecutableInfo {
  path?: string;
  source: ClaudeExecutableSource;
  reason?: string;
}

export interface ClaudeExecutableSpawn {
  command: string;
  args: string[];
  shell: boolean;
}

export interface ClaudeAvailability {
  available: boolean;
  reason?: string;
  detail?: string;
  version?: string;
}

const CLAUDE_AVAILABILITY_CACHE_MS = 5000;

function existingFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.existsSync(filePath) ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function npmGlobalPackageDir(prefix: string, packageName: string): string {
  const parts = packageName.split("/");
  const nodeModules = process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
  return path.join(nodeModules, ...parts);
}

function resolveClaudePackageBin(prefix: string): string | undefined {
  const packageDir = npmGlobalPackageDir(prefix, "@anthropic-ai/claude-code");
  const packageJsonPath = path.join(packageDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
    const binValue = typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin?.claude || Object.values(pkg.bin || {})[0];
    if (!binValue) return undefined;
    return existingFile(path.resolve(packageDir, binValue));
  } catch {
    return undefined;
  }
}

function isJavaScriptRuntimeFile(filePath: string): boolean {
  return /\.(?:js|mjs|tsx?|jsx)$/i.test(filePath);
}

function resolveSdkClaudeBinary(): string | undefined {
  // Some SDK installs include both linux-*-musl and glibc optional-dep packages.
  // On glibc hosts, make the binary choice explicit so the SDK cannot pick a musl
  // binary and fail with ENOENT for /lib/ld-musl-*.so.1.
  if (process.platform !== "linux") return undefined;
  const arch = process.arch;
  const glibcRuntime = (process.report?.getReport() as any)?.header?.glibcVersionRuntime;
  const isGlibc = typeof glibcRuntime === "string" && glibcRuntime.length > 0;
  const glibcPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`;
  const muslPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`;
  const preferred = isGlibc ? [glibcPkg, muslPkg] : [muslPkg, glibcPkg];
  for (const pkg of preferred) {
    try { return require.resolve(pkg); } catch {}
  }
  return undefined;
}

function resolveInstalledClaudeCli(): string | undefined {
  const isWindows = process.platform === "win32";
  try {
    const command = isWindows ? "where.exe" : "which";
    const output = execFileSync(command, ["claude"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
    const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  } catch {}

  const home = os.homedir();
  const candidates = isWindows
    ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "claude.cmd") : undefined,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm", "claude.cmd") : undefined,
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
      ];
  return candidates.map(existingFile).find(Boolean);
}

function resolveManagedClaudeCli(): { path?: string; source?: ClaudeExecutableSource } {
  const managedPackageBin = resolveClaudePackageBin(managedNpmPrefix());
  if (managedPackageBin) return { path: managedPackageBin, source: "managed" };

  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  for (const name of names) {
    const managed = existingFile(path.join(managedNpmBinDir(), name));
    if (managed) return { path: managed, source: "managed" };
  }

  const legacyPackageBin = resolveClaudePackageBin(legacyManagedNpmPrefix());
  if (legacyPackageBin) return { path: legacyPackageBin, source: "legacy" };

  for (const name of names) {
    const legacy = existingFile(path.join(legacyManagedNpmBinDir(), name));
    if (legacy) return { path: legacy, source: "legacy" };
  }
  return {};
}

function resolveClaudeExecutable(): ClaudeExecutableInfo {
  const explicit =
    existingFile(process.env.CLAUDE_CODE_EXECUTABLE) ||
    existingFile(process.env.CLAUDE_CODE_PATH);
  if (explicit) return { path: explicit, source: "explicit" };

  const managed = resolveManagedClaudeCli();
  if (managed.path) return { path: managed.path, source: managed.source || "managed" };

  const sdk = resolveSdkClaudeBinary();
  if (sdk) return { path: sdk, source: "sdk" };

  const installed = resolveInstalledClaudeCli();
  if (installed) return { path: installed, source: "system" };

  return {
    source: "unresolved",
    reason: "No Claude executable was found in the SDK, SocketAgent toolchain, or PATH",
  };
}

let CLAUDE_EXECUTABLE_INFO = resolveClaudeExecutable();
let CLAUDE_BINARY_OVERRIDE: string | undefined = CLAUDE_EXECUTABLE_INFO.path;
let cachedClaudeAvailability: { checkedAt: number; value: ClaudeAvailability } | null = null;

function logClaudeExecutableInfo(): void {
  if (CLAUDE_BINARY_OVERRIDE) {
    console.log(`[SDK] Using Claude executable (${CLAUDE_EXECUTABLE_INFO.source}): ${CLAUDE_BINARY_OVERRIDE}`);
  } else if (CLAUDE_EXECUTABLE_INFO.reason) {
    console.warn(`[SDK] ${CLAUDE_EXECUTABLE_INFO.reason}`);
  }
}

logClaudeExecutableInfo();

export function getClaudeExecutableInfo(): ClaudeExecutableInfo {
  return { ...CLAUDE_EXECUTABLE_INFO };
}

export function buildClaudeExecutableSpawn(
  args: string[],
  info: ClaudeExecutableInfo = CLAUDE_EXECUTABLE_INFO
): ClaudeExecutableSpawn | undefined {
  if (!info.path) return undefined;
  if (isJavaScriptRuntimeFile(info.path)) {
    return {
      command: process.execPath,
      args: [info.path, ...args],
      shell: false,
    };
  }
  return {
    command: info.path,
    args,
    shell: false,
  };
}

function firstClaudeOutputLine(stdout?: string | Buffer, stderr?: string | Buffer): string | undefined {
  const text = `${stdout || ""}\n${stderr || ""}`.trim();
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export function invalidateClaudeAvailabilityCache(): void {
  cachedClaudeAvailability = null;
}

export function getClaudeAvailability(): ClaudeAvailability {
  const now = Date.now();
  if (cachedClaudeAvailability && now - cachedClaudeAvailability.checkedAt < CLAUDE_AVAILABILITY_CACHE_MS) {
    return cachedClaudeAvailability.value;
  }

  const cache = (value: ClaudeAvailability): ClaudeAvailability => {
    cachedClaudeAvailability = { checkedAt: Date.now(), value };
    return value;
  };

  const info = getClaudeExecutableInfo();
  if (!info.path) {
    return cache({
      available: false,
      reason: info.reason || "No Claude executable is available.",
    });
  }

  const probe = buildClaudeExecutableSpawn(["--version"], info);
  if (!probe) {
    return cache({
      available: false,
      reason: "No Claude executable is available.",
    });
  }

  const result = spawnSync(probe.command, probe.args, {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: probe.shell,
    windowsHide: true,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return cache({
      available: false,
      reason: code === "ENOENT"
        ? "Claude executable was not found."
        : `Claude executable probe failed: ${result.error.message}`,
      detail: firstClaudeOutputLine(result.stdout, result.stderr),
    });
  }

  if (result.status !== 0) {
    const detail = firstClaudeOutputLine(result.stdout, result.stderr);
    return cache({
      available: false,
      reason: detail
        ? `Claude executable probe exited ${result.status}: ${detail}`
        : `Claude executable probe exited ${result.status}`,
      detail,
    });
  }

  return cache({
    available: true,
    version: firstClaudeOutputLine(result.stdout, result.stderr),
  });
}

function claudeExecutableQueryOptions(): Record<string, unknown> {
  if (!CLAUDE_BINARY_OVERRIDE) return {};
  return {
    pathToClaudeCodeExecutable: CLAUDE_BINARY_OVERRIDE,
    ...(isJavaScriptRuntimeFile(CLAUDE_BINARY_OVERRIDE) ? { executable: process.execPath } : {}),
  };
}

export function refreshClaudeExecutableInfo(): ClaudeExecutableInfo {
  CLAUDE_EXECUTABLE_INFO = resolveClaudeExecutable();
  CLAUDE_BINARY_OVERRIDE = CLAUDE_EXECUTABLE_INFO.path;
  invalidateClaudeAvailabilityCache();
  logClaudeExecutableInfo();
  return getClaudeExecutableInfo();
}

interface PendingQuestion {
  questionId: string;
  resolve: (answers: Record<string, string>) => void;
  questionData?: ServerMessage; // stored so we can re-send on reconnect
}

interface MonitorState {
  monitoring: boolean;
  description: string;
  outputFile: string;
  lastSize: number;
  readerInterval: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  outputBuffer: string[];
  timeoutTimer: NodeJS.Timeout | null;
  timeoutSeconds: number | null;
  process?: import("child_process").ChildProcess;
}

const DEFAULT_CLAUDE_WARM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CLAUDE_WARM_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.CLAUDE_WARM_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLAUDE_WARM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLAUDE_WARM_IDLE_TIMEOUT_MS;
  return Math.floor(parsed);
})();

type ClaudeQueuedUserMessage = {
  type: "user";
  uuid: string;
  session_id: string;
  message: {
    role: "user";
    content: string;
  };
  parent_tool_use_id: null;
  priority?: "now" | "next" | "later";
};

class ClaudeInputQueue implements AsyncIterable<ClaudeQueuedUserMessage> {
  private messages: ClaudeQueuedUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<ClaudeQueuedUserMessage>) => void> = [];
  private closed = false;

  push(message: ClaudeQueuedUserMessage): void {
    if (this.closed) throw new Error("Claude input queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }
    this.messages.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeQueuedUserMessage> {
    return {
      next: () => {
        const message = this.messages.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise<IteratorResult<ClaudeQueuedUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

interface PendingTurn {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class ClaudeSession {
  private sessionId: string | null = null;
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private abortController: AbortController | null = null;
  private activeQuery: ReturnType<typeof query> | null = null;
  private activeInputQueue: ClaudeInputQueue | null = null;
  private warmIdleTimer: NodeJS.Timeout | null = null;
  private pendingTurns: PendingTurn[] = [];
  private questionCounter = 0;
  private _isRunning = false;
  private _isWarmIdle = false;
  private _runStartedAt: string | null = null;
  private _ttsEnabled = false;
  private _ttsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  private _kokoroVoice: string = "af_heart";
  private _kokoroSpeed: number = 1.0;
  private _effort: 'low' | 'medium' | 'high' | 'max' = 'high';
  private _thinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };
  private _disallowedTools: string[] = [];
  private _appendSystemPrompt: string = '';
  private _systemPromptOverride: string | undefined;
  private _autoCompactEnabled = true;
  private _forkFromSessionId?: string;
  private _suppressedToolResultIds: Set<string> = new Set();  // toolUseIds whose results should be hidden from client
  private _taskIdToToolUseId: Map<string, string> = new Map();  // agentId → toolUseId mapping
  private _monitoredTasks: Map<string, MonitorState> = new Map();
  private _taskOutputFiles: Map<string, string> = new Map();  // taskId → outputFile path
  private _activeSubagents: Map<string, { agentId?: string; toolUseId: string; description: string; subagentType: string; startedAt: string; parentToolUseId?: string }> = new Map();
  private _activeBashStream: { interval: NodeJS.Timeout; filePath: string; lastSize: number } | null = null;
  private _bgBashWatchers: Map<string, { interval: NodeJS.Timeout; filePath: string; lastSize: number }> = new Map();
  private _activeToolUseId: string | null = null;  // currently-executing tool call
  private _activeToolName: string | null = null;
  private _readToolPaths: Map<string, string> = new Map();  // toolUseId → file_path for Read tool calls
  private _toolParentIds: Map<string, string> = new Map();  // toolUseId → owning subagent toolUseId
  private _isCompacting = false;  // whether context compaction is in progress
  private _compactStartedAt: string | null = null;
  private _permissionMode: string | null = null;  // current permission mode (e.g., "plan")
  private _authErrorSent = false;  // suppress duplicate exit-code error after auth failure
  private _authRequest: ClaudeAuthRequest | null = null;
  private _lastContextWindow = 0;  // last known context window size from modelUsage
  private _sessionModel: string | null = null;  // model reported by SessionStart hook
  private _requestedModel: string | null = null;
  private _streamingText = new Map<string, { content: string; parentToolUseId?: string; uuid?: string }>();
  private _streamingThinking = new Map<string, { content: string; parentToolUseId?: string; uuid?: string }>();
  private _lastPreview: string = "";
  private _lastSessionInit: ServerMessage | null = null;
  private _lastSupportedModels: ServerMessage | null = null;
  private _lastSupportedCommands: ServerMessage | null = null;
  private _lastSupportedAgents: ServerMessage | null = null;
  private clientSockets = new Set<WebSocket>();
  private sessionEventDelivery = new SessionEventDelivery((message) => {
    this.dispatchToClients(message as ServerMessage);
  });
  public onActivity?: () => void;
  public onClose?: () => void;
  public onMonitorOutput?: (text: string) => void;
  // When set, this fresh session replaces an old cleared session — remap the ID in the store
  public replacesSessionId?: string;
  // Queue for injecting user messages mid-conversation
  private _pendingInjections: Array<{
    text: string;
    resolve: () => void;
  }> = [];

  constructor(
    private ws: WebSocket,
    private cwd: string,
    private plugins: SocketAgentPlugin[] = []
  ) {
    this.attachWebSocket(ws);
  }

  setTtsEnabled(enabled: boolean): void {
    this._ttsEnabled = enabled;
    console.log(`TTS ${enabled ? 'enabled' : 'disabled'} for session ${this.sessionId || '(pending)'}`);
  }

  get ttsEnabled(): boolean {
    return this._ttsEnabled;
  }

  setTtsEngine(engine: "system" | "kokoro_server" | "kokoro_device"): void {
    this._ttsEngine = engine;
    console.log(`TTS engine set to ${engine} for session ${this.sessionId || '(pending)'}`);
  }

  get ttsEngine(): string {
    return this._ttsEngine;
  }

  setKokoroVoice(voice: string): void {
    this._kokoroVoice = voice;
  }

  setKokoroSpeed(speed: number): void {
    this._kokoroSpeed = speed;
  }

  setEffort(effort: 'low' | 'medium' | 'high' | 'max'): void {
    this._effort = effort;
    this.persistAgentSettings({ effort });
    console.log(`Effort set to ${effort} for session ${this.sessionId || '(pending)'}`);
  }

  get effort(): string {
    return this._effort;
  }

  setThinking(thinking: typeof ClaudeSession.prototype._thinking): void {
    this._thinking = thinking;
    this.persistAgentSettings({ thinking });
    console.log(`Thinking set to ${JSON.stringify(thinking)} for session ${this.sessionId || '(pending)'}`);
  }

  get thinking() {
    return this._thinking;
  }

  setDisallowedTools(tools: string[]): void {
    this._disallowedTools = [...tools];
    this.persistAgentSettings({ disallowedTools: this._disallowedTools });
    console.log(`Disallowed tools set to [${tools.join(', ')}] for session ${this.sessionId || '(pending)'}`);
  }

  setAppendSystemPrompt(text: string, options: { inherited?: boolean; clearOverride?: boolean } = {}): void {
    this._appendSystemPrompt = text;
    if (options.clearOverride) {
      this._systemPromptOverride = undefined;
      this.persistAgentSettings({ systemPrompt: undefined });
    } else if (!options.inherited) {
      this._systemPromptOverride = text;
      this.persistAgentSettings({ systemPrompt: text });
    }
    console.log(`Append system prompt set (${text.length} chars) for session ${this.sessionId || '(pending)'}`);
  }

  setClaudeAutoCompact(enabled: boolean): void {
    this._autoCompactEnabled = enabled;
    this.persistAgentSettings({ claudeAutoCompact: enabled });
    console.log(`Claude auto-compact ${enabled ? 'enabled' : 'disabled'} for session ${this.sessionId || '(pending)'}`);
  }

  private claudeFlagSettings(): Settings {
    return {
      autoCompactEnabled: this._autoCompactEnabled,
    };
  }

  setForkSource(sessionId: string): void {
    this._forkFromSessionId = sessionId;
    console.log(`Fork source set to ${sessionId}`);
  }

  private _resumeSessionAt?: string;

  /** Set a message UUID to resume the conversation at (truncates conversation after this point) */
  setResumeSessionAt(uuid: string): void {
    this._resumeSessionAt = uuid;
    console.log(`Resume-at set to ${uuid}`);
  }

  private _stoppedTasks: Set<string> = new Set();  // prevent duplicate stop notifications

  async stopTask(taskId: string): Promise<void> {
    // Deduplicate — only process the first stop request per task
    if (this._stoppedTasks.has(taskId)) {
      console.log(`[StopTask] Already stopped ${taskId}, ignoring`);
      return;
    }
    this._stoppedTasks.add(taskId);
    console.log(`[StopTask] Processing stop for ${taskId}, activeQuery=${!!this.activeQuery}`);

    if (!this.activeQuery) {
      console.log(`[StopTask] No active query for task ${taskId} — task likely already finished`);
      return;
    }
    // The app sends toolUseId, but the SDK needs the agentId
    let sdkTaskId = taskId;
    for (const [agentId, toolUseId] of this._taskIdToToolUseId.entries()) {
      if (toolUseId === taskId) {
        sdkTaskId = agentId;
        break;
      }
    }
    console.log(`[StopTask] Calling SDK stopTask(${sdkTaskId})`);
    // Fire and forget — don't await, the SDK will handle it async
    this.activeQuery.stopTask(sdkTaskId).then(() => {
      console.log(`[StopTask] SDK stopped task ${sdkTaskId}`);
    }).catch(e => {
      console.error(`[StopTask] SDK error stopping ${sdkTaskId}: ${e}`);
    });
  }

  private _startBashWatcher(filePath: string): void {
    this._stopBashWatcher();  // clean up any previous watcher
    console.log(`[BashWatcher] Starting on ${filePath}`);
    const state = { interval: null as any, filePath, lastSize: 0 };
    state.interval = setInterval(() => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > state.lastSize) {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(stat.size - state.lastSize);
          fs.readSync(fd, buf, 0, buf.length, state.lastSize);
          fs.closeSync(fd);
          state.lastSize = stat.size;
          const content = buf.toString("utf8");
          this.send({
            type: "tool_stderr",
            content,
            sessionId: this.sessionId || "",
          } as any);
        }
      } catch {}
    }, 500);
    this._activeBashStream = state;
  }

  private _stopBashWatcher(): void {
    if (this._activeBashStream) {
      clearInterval(this._activeBashStream.interval);
      this._activeBashStream = null;
    }
  }

  /** Independent watcher for backgrounded bash tasks — survives when next tool starts */
  private _startBgBashWatcher(taskId: string, toolUseId: string, filePath: string): void {
    this._stopBgBashWatcher(taskId);
    console.log(`[BgBashWatcher] Starting for ${taskId} (toolUseId=${toolUseId}) on ${filePath}`);
    const state = { interval: null as any, filePath, lastSize: 0 };
    state.interval = setInterval(() => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > state.lastSize) {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(stat.size - state.lastSize);
          fs.readSync(fd, buf, 0, buf.length, state.lastSize);
          fs.closeSync(fd);
          state.lastSize = stat.size;
          const content = buf.toString("utf8");
          this.send({
            type: "tool_stderr",
            toolUseId,
            content,
            sessionId: this.sessionId || "",
          } as any);
        }
      } catch {}
    }, 1000);
    state.interval = state.interval;
    this._bgBashWatchers.set(taskId, state);
  }

  private _stopBgBashWatcher(taskId: string): void {
    const watcher = this._bgBashWatchers.get(taskId);
    if (watcher) {
      clearInterval(watcher.interval);
      this._bgBashWatchers.delete(taskId);
    }
  }

  // ── Monitor output tailing ──

  private _startMonitorReader(taskId: string): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state) return;
    this._stopMonitorReader(taskId);  // clean up any previous reader

    console.log(`[Monitor] Starting reader for ${taskId} on ${state.outputFile}`);
    state.readerInterval = setInterval(() => {
      try {
        if (!fs.existsSync(state.outputFile)) return;
        const stat = fs.statSync(state.outputFile);
        if (stat.size > state.lastSize) {
          const fd = fs.openSync(state.outputFile, "r");
          const buf = Buffer.alloc(stat.size - state.lastSize);
          fs.readSync(fd, buf, 0, buf.length, state.lastSize);
          fs.closeSync(fd);
          state.lastSize = stat.size;
          const newContent = buf.toString("utf8");
          const lines = newContent.split("\n").filter(l => l.length > 0);
          if (lines.length > 0) {
            // Send to app immediately for live display in task pane
            const lineContent = lines.join("\n");
            this.send({
              type: "monitor_output",
              taskId,
              content: lineContent,
              sessionId: this.sessionId || "",
            } as any);
            // Persist to history so monitor cards restore on session load
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "monitor",
                content: lineContent,
                taskId,
                description: state.description,
                timestamp: new Date().toISOString(),
              });
            }
            // Accumulate for Claude injection (5s debounce)
            state.outputBuffer.push(...lines);
            if (state.debounceTimer) clearTimeout(state.debounceTimer);
            state.debounceTimer = setTimeout(() => {
              this._flushMonitorBuffer(taskId);
            }, 5000);
          }
        }
      } catch {}
    }, 500);
  }

  private _stopMonitorReader(taskId: string): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state) return;
    if (state.readerInterval) {
      clearInterval(state.readerInterval);
      state.readerInterval = null;
    }
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
  }

  private _flushMonitorBuffer(taskId: string): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state || state.outputBuffer.length === 0) return;

    const content = state.outputBuffer.join("\n");
    state.outputBuffer = [];
    state.debounceTimer = null;

    const text = `[Monitor: "${state.description}" (${taskId})]\n${content}`;
    console.log(`[Monitor] Flushing ${content.length} chars for ${taskId}`);

    // Inject to Claude or start new query (app already gets live output from reader)
    if (this._isRunning && this.activeQuery) {
      this.injectMessage(text, 'next').catch(e => {
        console.error(`[Monitor] Inject error: ${e}`);
      });
    } else if (this.onMonitorOutput) {
      this.onMonitorOutput(text);
    }
  }

  private _cleanupMonitor(taskId: string, flush = false): void {
    const state = this._monitoredTasks.get(taskId);
    if (!state) return;

    console.log(`[Monitor] Cleaning up ${taskId} (flush=${flush})`);
    this._stopMonitorReader(taskId);

    if (flush && state.outputBuffer.length > 0) {
      this._flushMonitorBuffer(taskId);
    }

    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    // Kill Monitor-spawned processes
    if (state.process) {
      try {
        if (state.process.pid) {
          process.kill(-state.process.pid, "SIGTERM");
          // Force kill after 5s if still alive
          setTimeout(() => {
            try { if (state.process?.pid) process.kill(-state.process.pid, "SIGKILL"); } catch {}
          }, 5000);
        }
      } catch {}
    }

    this._monitoredTasks.delete(taskId);

    // Notify app
    this.send({
      type: "monitor_started",
      taskId,
      description: state.description,
      monitoring: false,
      sessionId: this.sessionId || "",
    } as any);
  }

  private _cleanupAllMonitors(): void {
    for (const taskId of Array.from(this._monitoredTasks.keys())) {
      this._cleanupMonitor(taskId, false);
    }
  }

  public stopMonitoring(taskId: string): void {
    this._cleanupMonitor(taskId, true);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get isWarmIdle(): boolean {
    return this._isWarmIdle;
  }

  get isBusy(): boolean {
    return this._isRunning || this._isCompacting;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  get activeStartedAt(): string | null {
    if (this._isCompacting) return this._compactStartedAt || this._runStartedAt;
    if (this._isRunning) return this._runStartedAt;
    return null;
  }

  get permissionMode(): string | null {
    return this._permissionMode;
  }

  private _clearWarmIdleTimer(): void {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
  }

  private _resolvePendingTurn(): void {
    const pending = this.pendingTurns.shift();
    pending?.resolve();
  }

  private _rejectPendingTurns(err: Error): void {
    while (this.pendingTurns.length > 0) {
      const pending = this.pendingTurns.shift();
      pending?.reject(err);
    }
  }

  private _trackPendingTurn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingTurns.push({ resolve, reject });
    });
  }

  private _createUserMessage(
    text: string,
    sessionId: string,
    uuid: string,
    priority?: "now" | "next" | "later",
  ): ClaudeQueuedUserMessage {
    return {
      type: "user",
      uuid,
      session_id: sessionId,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    };
  }

  private _enterWarmIdle(): void {
    if (!this.activeQuery || !this.activeInputQueue || CLAUDE_WARM_IDLE_TIMEOUT_MS <= 0) return;
    this._isRunning = false;
    this._isWarmIdle = true;
    this._clearWarmIdleTimer();
    const sid = this.sessionId || "";
    this.warmIdleTimer = setTimeout(() => {
      if (!this._isWarmIdle) return;
      console.log(`[WarmIdle] Closing Claude SDK stream for ${sid || "(unknown)"} after ${CLAUDE_WARM_IDLE_TIMEOUT_MS}ms idle`);
      this._isWarmIdle = false;
      this.activeInputQueue?.close();
      try { this.activeQuery?.close(); } catch {}
    }, CLAUDE_WARM_IDLE_TIMEOUT_MS);
    this.warmIdleTimer.unref?.();
    console.log(`[WarmIdle] Keeping Claude SDK stream open for ${sid || "(pending)"} (${CLAUDE_WARM_IDLE_TIMEOUT_MS}ms timeout)`);
  }

  private _leaveWarmIdle(): void {
    this._clearWarmIdleTimer();
    this._isWarmIdle = false;
  }

  get sessionModel(): string | null {
    return this._sessionModel;
  }

  /** Active background task IDs (agentId → toolUseId) */
  get activeBackgroundTasks(): Map<string, string> {
    return this._taskIdToToolUseId;
  }

  /** Active subagent tasks with metadata */
  getActiveSubagents(): Array<{ agentId: string; toolUseId: string; description: string; subagentType: string; startedAt: string; parentToolUseId?: string }> {
    return Array.from(this._activeSubagents.entries()).map(([toolUseId, info]) => ({
      agentId: info.agentId || toolUseId,
      toolUseId: info.toolUseId,
      description: info.description,
      subagentType: info.subagentType,
      startedAt: info.startedAt,
      ...(info.parentToolUseId ? { parentToolUseId: info.parentToolUseId } : {}),
    }));
  }

  private _streamKey(message: any): string {
    const parentToolUseId = String(message?.parent_tool_use_id || "");
    const uuid = String(message?.uuid || "");
    return `${parentToolUseId || "main"}:${uuid || "current"}`;
  }

  private _appendLiveStream(
    streams: Map<string, { content: string; parentToolUseId?: string; uuid?: string }>,
    message: any,
    content: string,
  ): string {
    const key = this._streamKey(message);
    const parentToolUseId = String(message?.parent_tool_use_id || "") || undefined;
    const uuid = String(message?.uuid || "") || undefined;
    const existing = streams.get(key);
    streams.set(key, {
      content: (existing?.content || "") + content,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(uuid ? { uuid } : {}),
    });
    return key;
  }

  private _clearLiveStreamsForMessage(message: any): void {
    const key = this._streamKey(message);
    this._streamingText.delete(key);
    this._streamingThinking.delete(key);
  }

  /** Currently-executing tool call info (null if no tool is running) */
  getActiveToolCall(): { toolUseId: string; name: string } | null {
    if (this._activeToolUseId && this._activeToolName) {
      return { toolUseId: this._activeToolUseId, name: this._activeToolName };
    }
    return null;
  }

  /** Read accumulated bash output from the live log file (for replay on reconnect) */
  getAccumulatedBashOutput(): string | null {
    if (!this._activeBashStream) return null;
    try {
      if (!fs.existsSync(this._activeBashStream.filePath)) return null;
      const content = fs.readFileSync(this._activeBashStream.filePath, "utf8");
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  get lastPreview(): string {
    return this._lastPreview;
  }

  getCwd(): string {
    return this.cwd;
  }

  /** Swap the WebSocket so a reconnecting client receives future messages */
  setWebSocket(ws: WebSocket): void {
    this.attachWebSocket(ws);
    // Re-send cached session init and models so app UI populates immediately
    if (this._lastSessionInit) this.sendTo(ws, this._lastSessionInit);
    if (this._lastSupportedModels) this.sendTo(ws, this._lastSupportedModels);
    if (this._lastSupportedCommands) this.sendTo(ws, this._lastSupportedCommands);
    if (this._lastSupportedAgents) this.sendTo(ws, this._lastSupportedAgents);
    this.replayPendingInteractions(ws);
    this.sessionEventDelivery.replayTo((message) => {
      this.sendTo(ws, message as ServerMessage);
    });
  }

  acknowledgeSessionEvent(deliveryId: string): boolean {
    return this.sessionEventDelivery.acknowledge(deliveryId);
  }

  replayLiveState(ws: WebSocket = this.ws): void {
    const activeTool = this.getActiveToolCall();
    if (activeTool) {
      this.sendTo(ws, {
        type: "tool_call",
        tool: activeTool.name,
        input: {},
        toolUseId: activeTool.toolUseId,
        sessionId: this.sessionId || "",
        replay: true,
      } as any);
    }
    for (const [streamId, stream] of this._streamingThinking) {
      this.sendTo(ws, {
        type: "thinking",
        content: stream.content,
        sessionId: this.sessionId || "",
        streamId,
        ...(stream.parentToolUseId ? { parentToolUseId: stream.parentToolUseId } : {}),
        ...(stream.uuid ? { uuid: stream.uuid } : {}),
        replay: true,
      });
    }
    for (const [streamId, stream] of this._streamingText) {
      this.sendTo(ws, {
        type: "text",
        content: stream.content,
        sessionId: this.sessionId || "",
        streamId,
        ...(stream.parentToolUseId ? { parentToolUseId: stream.parentToolUseId } : {}),
        ...(stream.uuid ? { uuid: stream.uuid } : {}),
        replay: true,
      });
    }
    // setWebSocket may run before session_history is delivered. Replay these
    // again afterward so a history replacement cannot hide an open card.
    this.replayPendingInteractions(ws);
  }

  private replayPendingInteractions(ws: WebSocket = this.ws): void {
    // Re-send any pending (unanswered) questions so the reconnecting client can respond
    for (const [, pending] of this.pendingQuestions) {
      if (pending.questionData) {
        this.sendTo(ws, pending.questionData);
      }
    }
    for (const pendingSecureInput of pendingSecureInputMessagesForSession(this.sessionId || "")) {
      this.sendTo(ws, pendingSecureInput as ServerMessage);
    }
    // Send active subagent tasks so the app can render SubAgentCards
    const activeSubagents = this.getActiveSubagents();
    if (activeSubagents.length > 0) {
      console.log(`[Resume] Sending ${activeSubagents.length} active subagents`);
    }
    this.sendTo(ws, {
      type: "active_subagents",
      tasks: activeSubagents,
      sessionId: this.sessionId || "",
      backend: "claude",
      replace: true,
    } as ActiveSubagentsServerMessage);
  }

  /** Detach the WebSocket so this session stops sending to the client.
   *  The session continues running in the background (history is still logged). */
  detachWebSocket(): void {
    // Live output is session-scoped and the app filters by sessionId. Keep
    // attached sockets until they close so reconnects/probes don't steal the
    // stream from another visible client.
  }

  private attachWebSocket(ws: WebSocket): void {
    this.ws = ws;
    this.clientSockets.add(ws);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(redactSecretsDeep(msg)));
    }
  }

  public send(msg: ServerMessage): void {
    this.dispatchToClients(this.sessionEventDelivery.prepare(msg as any) as ServerMessage);
  }

  private dispatchToClients(msg: ServerMessage): void {
    const payload = JSON.stringify(redactSecretsDeep(msg));
    for (const socket of [...this.clientSockets]) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        this.clientSockets.delete(socket);
      }
    }
  }

  getSessionContext(): SessionContext {
    const sid = this.sessionId || "";
    return {
      sessionId: sid,
      cwd: this.cwd,
      send: (msg) => this.send(msg as ServerMessage),
      appendHistory: (entry) => { if (sid) appendHistory(sid, entry); },
      pendingQuestions: this.pendingQuestions,
      questionCounter: { next: () => `q${++this.questionCounter}` },
    };
  }

  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      pending.resolve(answers);
      this.pendingQuestions.delete(questionId);
      // Mark as answered in persisted history
      if (this.sessionId) {
        markQuestionAnswered(this.sessionId, questionId);
      }
      return true;
    }
    return false;
  }

  abort(): void {
    this._leaveWarmIdle();
    this.abortController?.abort();
    this.activeInputQueue?.close();
    this.activeInputQueue = null;
    // close() forcefully terminates the CLI subprocess and all its children
    if (this.activeQuery) {
      try { this.activeQuery.close(); } catch {}
      this.activeQuery = null;
    }
    this._rejectPendingTurns(new Error("Claude session aborted"));
    this._isRunning = false;
    this._isCompacting = false;
    this._runStartedAt = null;
    this._compactStartedAt = null;
    // Kill all monitored processes and clean up readers
    this._cleanupAllMonitors();
    // Stop all background bash watchers
    for (const [taskId] of this._bgBashWatchers) {
      this._stopBgBashWatcher(taskId);
    }
  }

  closeWarmIdle(): void {
    if (!this._isWarmIdle) return;
    this._leaveWarmIdle();
    this.activeInputQueue?.close();
    try { this.activeQuery?.close(); } catch {}
  }

  /** Gracefully stop the current query between turns — session stays alive and can continue */
  interrupt(): void {
    if (this.activeQuery) {
      this.activeQuery.interrupt();
    }
  }

  /** Switch model mid-session. Pass undefined to reset to default. */
  async setModel(model?: string): Promise<void> {
    this._requestedModel = model ?? null;
    this._sessionModel = model ?? null;
    if (this.activeQuery) {
      await this.activeQuery.setModel(model);
      console.log(`[Model] Set to ${model || 'default'} for session ${this.sessionId || '(pending)'}`);
    }
    this.persistAgentSettings({ model });
  }

  getAgentSettings(): AgentSessionSettings {
    return {
      ...(this._requestedModel || this._sessionModel ? { model: this._requestedModel || this._sessionModel || undefined } : {}),
      effort: this._effort,
      thinking: this._thinking,
      claudeAutoCompact: this._autoCompactEnabled,
      disallowedTools: [...this._disallowedTools],
      ...(this._systemPromptOverride !== undefined ? { systemPrompt: this._systemPromptOverride } : {}),
    };
  }

  private persistAgentSettings(patch: Partial<AgentSessionSettings>): void {
    const sid = this.sessionId;
    if (sid) updateSessionAgentSettings(sid, patch);
  }

  /** Switch permission mode mid-session (e.g., 'plan', 'default', 'acceptEdits'). */
  async setPermissionMode(mode: string): Promise<void> {
    this._permissionMode = mode;
    this.persistPermissionMode(mode);
    if (this.activeQuery) {
      await this.activeQuery.setPermissionMode(mode as any);
      console.log(`[PermissionMode] Set to ${mode} for session ${this.sessionId || '(pending)'}`);
    }
  }

  private persistPermissionMode(mode: string): void {
    if (!this.sessionId) return;
    const session = getSession(this.sessionId);
    if (session) {
      session.permissionMode = mode;
      saveSession(session);
    }
    appendHistory(this.sessionId, {
      role: "permission_mode",
      content: "",
      permissionMode: mode,
      timestamp: new Date().toISOString(),
    });
  }

  /** Get MCP server health status */
  async mcpServerStatus(): Promise<any> {
    if (this.activeQuery) {
      return this.activeQuery.mcpServerStatus();
    }
    return null;
  }

  /** Reconnect a failed MCP server */
  async reconnectMcpServer(name: string): Promise<any> {
    if (this.activeQuery) {
      return (this.activeQuery as any).reconnectMcpServer(name);
    }
    return null;
  }

  /** Toggle an MCP server on/off */
  async toggleMcpServer(name: string, enabled: boolean): Promise<any> {
    if (this.activeQuery) {
      return (this.activeQuery as any).toggleMcpServer(name, enabled);
    }
    return null;
  }

  /** Rewind files to a specific message UUID (requires file checkpointing) */
  async rewindFiles(uuid: string, dryRun = false): Promise<any> {
    if (this.activeQuery) {
      return this.activeQuery.rewindFiles(uuid, { dryRun });
    }
    return null;
  }

  /** Inject a user message into the running conversation between turns.
   *  priority: 'now' = interrupt current tool, 'next' = between turns, 'later' = after current task */
  async injectMessage(text: string, priority: 'now' | 'next' | 'later' = 'now', _messageId?: string): Promise<void> {
    if (!this.activeQuery || !this._isRunning) return;
    console.log(`[Inject] Queuing message (priority=${priority}): ${text.slice(0, 80)}...`);

    const sessionId = this.sessionId || "";
    const userMsgUuid = crypto.randomUUID();

    // Log injected message to history so it persists across sessions
    if (sessionId) {
      appendHistory(sessionId, {
        role: "user",
        content: text,
        uuid: userMsgUuid,
        timestamp: new Date().toISOString(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: userMsgUuid,
        sessionId,
      } as any);
    }

    // Create an async iterable that yields the user message
    const userMessage = {
      type: "user" as const,
      uuid: userMsgUuid,
      message: {
        role: "user" as const,
        content: text,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      priority,
    };

    const singleMessageStream = async function* () {
      yield userMessage;
    };

    try {
      await this.activeQuery.streamInput(singleMessageStream());
      console.log(`[Inject] Message injected successfully`);
    } catch (e) {
      console.error(`[Inject] streamInput error: ${e}`);
    }
  }

  private async _runWarmPrompt(prompt: string, resumeSessionId?: string): Promise<void> {
    if (!this.activeQuery || !this.activeInputQueue) {
      throw new Error("Claude warm session is not available");
    }
    this._leaveWarmIdle();
    this._isRunning = true;
    this._runStartedAt = new Date().toISOString();
    this._authErrorSent = false;
    this._streamingText.clear();
    this._streamingThinking.clear();
    this._lastPreview = "";
    this.onActivity?.();

    const sid = resumeSessionId || this.sessionId || "";
    const userMsgUuid = crypto.randomUUID();
    const turnPromise = this._trackPendingTurn();

    if (sid) {
      appendHistory(sid, {
        role: "user",
        content: prompt,
        uuid: userMsgUuid,
        timestamp: new Date().toISOString(),
      });
      this.send({
        type: "user_message_uuid",
        uuid: userMsgUuid,
        sessionId: sid,
      } as any);
    }

    this.activeInputQueue.push(this._createUserMessage(prompt, sid, userMsgUuid));
    console.log(`[WarmIdle] Reusing Claude SDK stream for ${sid || "(pending)"}, prompt=${prompt.slice(0, 80)}...`);
    return turnPromise;
  }

  async runQuery(prompt: string, resumeSessionId?: string): Promise<void> {
    if (this.activeQuery && this.activeInputQueue && this._isWarmIdle) {
      return this._runWarmPrompt(prompt, resumeSessionId);
    }

    this.abortController = new AbortController();
    this._isRunning = true;
    this._runStartedAt = new Date().toISOString();
    this._isWarmIdle = false;
    this._clearWarmIdleTimer();
    this._authErrorSent = false;
    this._streamingText.clear();
    this._streamingThinking.clear();
    this._lastPreview = "";
    this.onActivity?.();

    try {
      // Strip CLAUDECODE env var to allow running inside a Claude Code session
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "CLAUDECODE" && v !== undefined) {
          cleanEnv[k] = v;
        }
      }
      // Inject session ID for tools that need to reach the app
      const sid = resumeSessionId || this.sessionId || "";
      if (sid) cleanEnv["CLAUDE_SESSION_ID"] = sid;
      // Enable file checkpointing for rewind support
      cleanEnv["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"] = "1";
      // Give MCP tool results more time to propagate before stream closes
      cleanEnv["CLAUDE_CODE_STREAM_CLOSE_TIMEOUT"] = "10000";
      // Force-enable prompt suggestions
      cleanEnv["CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION"] = "1";
      // Enable fine-grained tool output streaming (streams bash output incrementally)
      cleanEnv["CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"] = "1";
      // Enable bash_progress events in tool_progress (SDK only emits in remote/container mode)
      cleanEnv["CLAUDE_CODE_CONTAINER_ID"] = "socketagent";
      // Enable session state change events (idle/running/requires_action)
      cleanEnv["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"] = "1";

      // Merge plugin environment variables
      for (const plugin of this.plugins) {
        if (plugin.envVars) {
          Object.assign(cleanEnv, plugin.envVars());
        }
      }

      const appToolContext: AppToolContext = {
        getSessionId: () => this.sessionId || "",
        getCwd: () => this.cwd,
        getBackend: () => "claude",
        send: (msg) => this.send(msg as ServerMessage),
        appendHistory: (entry) => {
          if (this.sessionId) appendHistory(this.sessionId, entry as HistoryEntry);
        },
        getTtsEngine: () => this._ttsEngine,
        getKokoroVoice: () => this._kokoroVoice,
        getKokoroSpeed: () => this._kokoroSpeed,
      };

      // Build the MCP server with app-facing tools.
      const appTools = createSdkMcpServer({
        name: "app",
        tools: [
          tool(
            "Speak",
            "Speak text aloud to the user via text-to-speech. Use this to provide a concise spoken summary of your response. Keep it natural and conversational — no markdown, no code, no formatting. Summarize rather than reading everything verbatim. Only call this once per response. Avoid starting with a very short sentence — lead with a substantial opening sentence so audio playback begins with meaningful content.",
            { text: z.string().describe("The text to speak aloud to the user") },
            async (args) => handleSpeakTool(appToolContext, args)
          ),
          tool(
            "SendFile",
            "Send a file to the user's mobile device for download. Registers the file so the user can download it on-demand from the app. Use this when the user asks you to send, share, or transfer a file to their phone. NOTE: If this tool returns 'Stream closed' or similar transport error, the file was ALREADY sent successfully — do NOT retry.",
            {
              file_path: z.string().describe("Absolute path to the file to send"),
            },
            async (args) => handleSendFileTool(appToolContext, args)
          ),
          tool(
            "RequestSecureInput",
            "Ask the user to enter a credential, API key, token, or other secret through a secure app card. The secret is saved to a local 0600 file on the server, and this tool returns only the file path and metadata. Use this instead of asking the user to paste secrets into chat.",
            {
              label: z.string().describe("Short label for the secret, e.g. OPENAI_API_KEY or GitHub token"),
              reason: z.string().optional().describe("Why you need this secret, shown to the user"),
              envHint: z.string().optional().describe("Suggested environment variable name"),
              scope: z.enum(["session", "project", "global"]).optional().describe("Where to store it. Default: session"),
              timeoutSeconds: z.number().optional().describe("How long to wait for the user, 30-3600 seconds. Default: 600"),
            },
            async (args) => handleRequestSecureInputTool(appToolContext, args as any)
          ),
          tool(
            "ScheduleReminder",
            "Schedule a reminder notification on the user's mobile device. The notification will fire at the specified time even if the app is backgrounded. Use this when the user asks to be reminded about something at a specific time.",
            {
              title: z.string().describe("Short title for the reminder notification"),
              body: z.string().describe("Optional longer description for the notification body. Use empty string if not needed."),
              scheduledTime: z.string().describe("When to fire the reminder, in ISO 8601 format (e.g. 2026-02-18T15:30:00)"),
            },
            async (args) => handleScheduleReminderTool(appToolContext, args)
          ),
          tool(
            "NotifyUser",
            "Send an immediate notification to the user's mobile device. Use this when the user needs to know about an important result, especially from quiet scheduled tasks. Do not use for routine success messages unless the user explicitly asked to be notified.",
            {
              title: z.string().describe("Short notification title"),
              body: z.string().describe("Optional notification body. Use empty string if not needed."),
            },
            async (args) => handleNotifyUserTool(appToolContext, args)
          ),
          tool(
            "ScheduleTask",
            "Schedule a Claude or Codex prompt to run automatically at a future time. Creates a new session in the specified directory and executes the prompt when the scheduled time arrives. The server runs 24/7 so the task will execute even if the app is closed. Use this when the user wants to defer a task to run later. Supports provider, model, effort, permission, recurrence, and session-reuse settings.",
            {
              prompt: z.string().describe("The prompt/instructions for Claude to execute at the scheduled time"),
              cwd: z.string().describe("Working directory for the scheduled task (absolute path)"),
              backend: z.enum(["claude", "codex"]).optional().describe("Agent provider. Defaults to Claude."),
              model: z.string().optional().describe("Provider model ID. Omit to use the provider default."),
              effort: z.enum(["minimal", "low", "medium", "high", "max", "xhigh", "ultra"]).optional().describe("Reasoning effort for the scheduled run."),
              permissionMode: z.enum(["plan", "default", "auto", "acceptEdits", "bypassPermissions", "superYolo"]).optional().describe("Sandbox/permission mode for the scheduled run."),
              scheduledTime: z.string().describe("When to run the task, in ISO 8601 format (e.g. 2026-03-13T09:00:00)"),
              recurrenceType: z.enum(["once", "daily", "weekly", "monthly", "custom"]).optional().describe("How often to repeat. Default: once (no recurrence)"),
              customIntervalMs: z.number().optional().describe("Custom interval in milliseconds (only used when recurrenceType is 'custom')"),
              reuseSession: z.boolean().optional().describe("If true and recurring, reuse the same session for all occurrences instead of creating new ones"),
              notificationMode: z.enum(["completion", "quiet"]).optional().describe("completion sends the normal completion notification. quiet sends no automatic notifications; the scheduled agent must call NotifyUser if the user should be alerted."),
            },
            async (args) => {
              const scheduledDate = new Date(args.scheduledTime);
              if (isNaN(scheduledDate.getTime())) {
                return { content: [{ type: "text" as const, text: `Invalid date format: ${args.scheduledTime}. Use ISO 8601 format.` }] };
              }
              if (scheduledDate.getTime() <= Date.now()) {
                return { content: [{ type: "text" as const, text: `Scheduled time is in the past. Please provide a future time.` }] };
              }

              const recurrenceType = args.recurrenceType || "once";
              const recurrence: RecurrenceConfig | undefined = recurrenceType !== "once" ? {
                type: recurrenceType,
                intervalMs: recurrenceType === "custom" ? args.customIntervalMs : undefined,
              } : undefined;

              const backend = (args.backend || "claude") as Backend;
              const task: ScheduledTask = {
                id: crypto.randomUUID(),
                prompt: args.prompt,
                cwd: args.cwd,
                backend,
                ...(backend === "codex" ? { codexDriver: "app-server" as const } : {}),
                ...(args.model?.trim() ? { model: args.model.trim() } : {}),
                ...(args.effort ? { effort: args.effort } : {}),
                ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
                scheduledTime: args.scheduledTime,
                createdAt: new Date().toISOString(),
                status: "pending",
                createdBySessionId: this.sessionId || undefined,
                recurrence,
                reuseSession: args.reuseSession || false,
                notificationMode: args.notificationMode === "quiet" ? "quiet" : "completion",
                runCount: 0,
                runs: [],
              };
              saveScheduledTask(task);

              // Notify the app about the new task
              this.send({
                type: "scheduled_task_update",
                task,
              } as any);

              const when = scheduledDate.toLocaleString();
              const recurrenceLabel = recurrence ? ` (recurring: ${recurrence.type})` : "";
              const notificationLabel = task.notificationMode === "quiet" ? " Quiet mode is on." : "";
              return { content: [{ type: "text" as const, text: `Task scheduled for ${when}${recurrenceLabel} in ${args.cwd}.${notificationLabel}\n"${args.prompt.slice(0, 300)}"` }] };
            }
          ),
          tool(
            "Monitor",
            "Monitor background process output. Two modes:\n1. Start a NEW background process with monitoring: provide command + description.\n2. Toggle monitoring on/off for an EXISTING background task: provide taskId.\nWhen monitoring is on, process output is debounced (5s batching) and delivered to you automatically so you can react. Timeout stops monitoring only — the process keeps running. To stop the process itself, use the existing task stop mechanism.",
            {
              command: z.string().optional().describe("Shell command to run in background with monitoring enabled (spawn mode)"),
              description: z.string().optional().describe("Human-readable description of what this process does"),
              timeoutSeconds: z.number().optional().describe("Auto-stop monitoring after N seconds (process keeps running)"),
              taskId: z.string().optional().describe("Existing background task ID to toggle monitoring for (toggle mode)"),
              enabled: z.boolean().optional().describe("Enable (true) or disable (false) monitoring. Default: true"),
            },
            async (args) => {
              try {
                const isSpawn = !!args.command;
                const isToggle = !!args.taskId && !args.command;

                if (!isSpawn && !isToggle) {
                  return { content: [{ type: "text" as const, text: "Monitor requires either 'command' (spawn mode) or 'taskId' (toggle mode)." }], isError: true };
                }

                if (isToggle) {
                  // ── Toggle mode: enable/disable monitoring on an existing background task ──
                  const taskId = args.taskId!;
                  const enabled = args.enabled !== false;

                  if (!enabled) {
                    if (this._monitoredTasks.has(taskId)) {
                      this._cleanupMonitor(taskId, true);
                      return { content: [{ type: "text" as const, text: `Monitoring disabled for task ${taskId}. Process continues running.` }] };
                    }
                    return { content: [{ type: "text" as const, text: `Task ${taskId} is not being monitored.` }] };
                  }

                  if (this._monitoredTasks.has(taskId)) {
                    return { content: [{ type: "text" as const, text: `Already monitoring task ${taskId}.` }] };
                  }

                  // Look up the output file for this task
                  const outputFile = this._taskOutputFiles.get(taskId);
                  if (!outputFile) {
                    // Also check by toolUseId (app sends toolUseId, SDK uses taskId)
                    let foundTaskId: string | undefined;
                    for (const [tid, tuid] of this._taskIdToToolUseId.entries()) {
                      if (tuid === taskId) { foundTaskId = tid; break; }
                    }
                    if (foundTaskId && this._taskOutputFiles.has(foundTaskId)) {
                      // Re-call with the correct SDK taskId
                      const realOutputFile = this._taskOutputFiles.get(foundTaskId)!;
                      const desc = args.description || `Task ${foundTaskId}`;
                      const monitorState: MonitorState = {
                        monitoring: true,
                        description: desc,
                        outputFile: realOutputFile,
                        lastSize: 0,
                        readerInterval: null,
                        debounceTimer: null,
                        outputBuffer: [],
                        timeoutTimer: null,
                        timeoutSeconds: args.timeoutSeconds || null,
                      };
                      this._monitoredTasks.set(foundTaskId, monitorState);
                      this._startMonitorReader(foundTaskId);
                      if (args.timeoutSeconds) {
                        monitorState.timeoutTimer = setTimeout(() => {
                          console.log(`[Monitor] Timeout reached for ${foundTaskId}`);
                          this._cleanupMonitor(foundTaskId!, true);
                        }, args.timeoutSeconds * 1000);
                      }
                      this.send({ type: "monitor_started", taskId: foundTaskId, description: desc, monitoring: true, sessionId: this.sessionId || "" } as any);
                      return { content: [{ type: "text" as const, text: `Monitoring enabled for task ${foundTaskId}.${args.timeoutSeconds ? ` Timeout: ${args.timeoutSeconds}s.` : ""}` }] };
                    }
                    return { content: [{ type: "text" as const, text: `No output file found for task ${taskId}. The task may not be a backgrounded bash command, or it may have already completed.` }], isError: true };
                  }

                  const desc = args.description || `Task ${taskId}`;
                  const monitorState: MonitorState = {
                    monitoring: true,
                    description: desc,
                    outputFile,
                    lastSize: 0,
                    readerInterval: null,
                    debounceTimer: null,
                    outputBuffer: [],
                    timeoutTimer: null,
                    timeoutSeconds: args.timeoutSeconds || null,
                  };
                  this._monitoredTasks.set(taskId, monitorState);
                  this._startMonitorReader(taskId);
                  if (args.timeoutSeconds) {
                    monitorState.timeoutTimer = setTimeout(() => {
                      console.log(`[Monitor] Timeout reached for ${taskId}`);
                      this._cleanupMonitor(taskId, true);
                    }, args.timeoutSeconds * 1000);
                  }
                  this.send({ type: "monitor_started", taskId, description: desc, monitoring: true, sessionId: this.sessionId || "" } as any);
                  return { content: [{ type: "text" as const, text: `Monitoring enabled for task ${taskId}.${args.timeoutSeconds ? ` Timeout: ${args.timeoutSeconds}s.` : ""}` }] };
                }

                // ── Spawn mode: start a new background process with monitoring ──
                const command = args.command!;
                const description = args.description || command.slice(0, 60);
                const taskId = `monitor-${crypto.randomUUID().slice(0, 8)}`;
                const outputFile = `/tmp/claude-monitor-${taskId}.log`;
                const syntheticToolUseId = `monitor-${taskId}`;

                console.log(`[Monitor] Spawning: ${command} → ${outputFile}`);

                // Create output file and spawn process
                const fd = fs.openSync(outputFile, "w");
                const child = spawn(command, [], {
                  shell: true,
                  detached: true,
                  stdio: ["ignore", fd, fd],
                  cwd: this.cwd,
                  windowsHide: true,
                });
                child.unref();
                fs.closeSync(fd);

                // Register in task tracking so it appears in the task pane
                this._taskIdToToolUseId.set(taskId, syntheticToolUseId);
                this._taskOutputFiles.set(taskId, outputFile);

                // Create monitor state
                const monitorState: MonitorState = {
                  monitoring: true,
                  description,
                  outputFile,
                  lastSize: 0,
                  readerInterval: null,
                  debounceTimer: null,
                  outputBuffer: [],
                  timeoutTimer: null,
                  timeoutSeconds: args.timeoutSeconds || null,
                  process: child,
                };
                this._monitoredTasks.set(taskId, monitorState);
                this._startMonitorReader(taskId);

                // Set timeout if specified
                if (args.timeoutSeconds) {
                  monitorState.timeoutTimer = setTimeout(() => {
                    console.log(`[Monitor] Timeout reached for ${taskId}`);
                    this._cleanupMonitor(taskId, true);
                  }, args.timeoutSeconds * 1000);
                }

                // Notify app about the new task + monitoring state
                this.send({ type: "task_started", taskId, toolUseId: syntheticToolUseId, description, taskType: "monitor", sessionId: this.sessionId || "" } as any);
                this.send({ type: "monitor_started", taskId, description, monitoring: true, command, sessionId: this.sessionId || "" } as any);

                // Listen for process exit
                child.on("exit", (code, signal) => {
                  console.log(`[Monitor] Process ${taskId} exited: code=${code} signal=${signal}`);
                  const state = this._monitoredTasks.get(taskId);
                  if (state) {
                    // Stop reader and flush remaining output
                    this._stopMonitorReader(taskId);
                    // Read any remaining output from file
                    try {
                      if (fs.existsSync(outputFile)) {
                        const stat = fs.statSync(outputFile);
                        if (stat.size > state.lastSize) {
                          const fd2 = fs.openSync(outputFile, "r");
                          const buf = Buffer.alloc(stat.size - state.lastSize);
                          fs.readSync(fd2, buf, 0, buf.length, state.lastSize);
                          fs.closeSync(fd2);
                          const remaining = buf.toString("utf8").split("\n").filter(l => l.length > 0);
                          if (remaining.length > 0) state.outputBuffer.push(...remaining);
                        }
                      }
                    } catch {}

                    // Flush buffer + send final exit message
                    if (state.outputBuffer.length > 0) {
                      this._flushMonitorBuffer(taskId);
                    }

                    const exitMsg = `[Monitor: "${description}" (${taskId})] Process exited with code ${code ?? "unknown"} (signal: ${signal || "none"})`;
                    if (this._isRunning && this.activeQuery) {
                      this.injectMessage(exitMsg, 'next').catch(() => {});
                    } else if (this.onMonitorOutput) {
                      this.onMonitorOutput(exitMsg);
                    }

                    // Clean up (don't flush again)
                    this._cleanupMonitor(taskId, false);
                  }

                  // Clean up task tracking
                  this._taskIdToToolUseId.delete(taskId);
                  this._taskOutputFiles.delete(taskId);

                  // Notify app task completed
                  this.send({
                    type: "task_notification",
                    taskId,
                    status: code === 0 ? "completed" : "failed",
                    summary: `Process exited with code ${code ?? "unknown"}`,
                    sessionId: this.sessionId || "",
                  } as any);
                });

                return { content: [{ type: "text" as const, text: `Process started and monitoring enabled. Task ID: ${taskId}. PID: ${child.pid || "unknown"}.${args.timeoutSeconds ? ` Monitoring timeout: ${args.timeoutSeconds}s.` : ""}` }] };
              } catch (e: any) {
                console.error(`[Monitor] Error: ${e.message}`, e.stack);
                return { content: [{ type: "text" as const, text: `Monitor error: ${e.message}` }], isError: true };
              }
            }
          ),
        ],
      });

      // Prepend tool context to the first prompt in a session
      const ttsInstruction = this._ttsEnabled
        ? `\n\nIMPORTANT: Text-to-speech is enabled. Before writing your final text response, you MUST call the Speak tool with a concise, natural spoken summary. Keep it brief and conversational — don't read code, URLs, or markdown aloud. If your response is short and simple, speak it nearly verbatim. If it's long or technical, summarize the key points. Always still write your full text response after speaking.`
        : "";

      // Collect plugin tool context fragments
      let pluginContext = "";
      for (const plugin of this.plugins) {
        if (plugin.toolContextFragment) {
          const fragment = plugin.toolContextFragment();
          if (fragment) pluginContext += "\n" + fragment;
        }
      }

      const secureInputInventory = secureInputInventoryForAgent(this.sessionId || undefined, this.cwd);
      const toolContext = `You can send an immediate mobile notification using NotifyUser(title, body). You can schedule reminders for the user using the ScheduleReminder tool — use ISO 8601 datetime for the scheduledTime parameter. You can also schedule deferred tasks using the ScheduleTask tool — these create a new Claude or Codex session that runs automatically at the specified time. Supports provider, model, effort, permissions, recurring schedules (daily, weekly, monthly, or custom interval), quiet notification mode, and optionally reusing the same session across recurrences.\n\nUse RequestSecureInput when you need an API key, password, auth token, cookie, or other secret. Do not ask the user to paste secrets into chat. The app will show a secure input card and the tool returns only a local secret file path plus metadata.\n\n${secureInputInventory}\n\nYou can monitor background processes using the Monitor tool. To start a new monitored process: Monitor(command="...", description="..."). To monitor an existing background task: Monitor(taskId="..."). To stop monitoring (process keeps running): Monitor(taskId="...", enabled=false). Monitored output is batched over 5 seconds and delivered to you automatically. Use timeoutSeconds to auto-stop monitoring after a duration.\n\n${SOCKETAGENT_FILE_LINK_INSTRUCTIONS}${ttsInstruction}${pluginContext}`;

      // Handle fork: use fork source as resume target + set forkSession flag
      const shouldFork = !!this._forkFromSessionId;
      const forkSourceId = this._forkFromSessionId;
      this._forkFromSessionId = undefined;

      const resumeTarget = shouldFork
        ? forkSourceId
        : (resumeSessionId || this.sessionId || undefined);

      // Consume resumeSessionAt (conversation rewind point)
      const resumeAt = this._resumeSessionAt;
      this._resumeSessionAt = undefined;

      // Pre-assign a UUID for this user message so we can wire up rewind support
      // immediately, without waiting for the SDK to echo it back. (Recent SDK versions stopped
      // emitting a `user` message echo for string prompts; we control the UUID here
      // and pass it via streaming-input mode so it lands in the SDK transcript with
      // the same ID we hand to the app.)
      const userMsgUuid = crypto.randomUUID();
      const promptSessionId = resumeTarget || this.sessionId || "";
      const promptStream = new ClaudeInputQueue();
      this.activeInputQueue = promptStream;
      promptStream.push(this._createUserMessage(prompt, promptSessionId, userMsgUuid));

      console.log(`Starting query: resume=${resumeTarget || 'none'}${shouldFork ? ' (FORK)' : ''}${resumeAt ? ` resumeAt=${resumeAt}` : ''}, effort=${this._effort}, thinking=${JSON.stringify(this._thinking)}, prompt=${prompt.slice(0, 80)}..., uuid=${userMsgUuid}, cwd=${this.cwd}`);

      const initialPermissionMode = this._permissionMode || "bypassPermissions";

      const q = this.activeQuery = query({
        prompt: promptStream as any,
        options: {
          cwd: this.cwd,
          ...claudeExecutableQueryOptions(),
          permissionMode: initialPermissionMode as any,
          allowDangerouslySkipPermissions: initialPermissionMode === "bypassPermissions",
          includePartialMessages: true,
          resume: resumeTarget,
          forkSession: shouldFork || undefined,
          resumeSessionAt: resumeAt,
          abortController: this.abortController,
          effort: this._effort as any,
          thinking: this._thinking as any,
          ...(this._requestedModel ? { model: this._requestedModel } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: this._appendSystemPrompt ? toolContext + '\n\n' + this._appendSystemPrompt : toolContext } as any,
          tools: { type: "preset", preset: "claude_code" },
          ...(this._disallowedTools.length ? { disallowedTools: this._disallowedTools } : {}),
          settings: this.claudeFlagSettings(),
          enableFileCheckpointing: true,
          promptSuggestions: true,
          agentProgressSummaries: true,
          toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
          settingSources: ["user", "project"],
          mcpServers: (() => {
            const servers: Record<string, any> = { "app": appTools };
            for (const plugin of this.plugins) {
              if (plugin.mcpServers) Object.assign(servers, plugin.mcpServers());
            }
            return servers;
          })(),
          allowedTools: (() => {
            const tools = ["mcp__app__*"];
            for (const plugin of this.plugins) {
              if (plugin.allowedTools) tools.push(...plugin.allowedTools());
            }
            return tools;
          })(),
          env: cleanEnv,
          hooks: {
            PreToolUse: [{
              hooks: [async (input: any) => {
                const toolName = input.tool_name || "";
                const toolInput = input.tool_input || {};

                // Run plugin interceptors
                const sessionCtx = this.getSessionContext();
                let pluginAllowed = false;
                console.log(`[Hook] PreToolUse: tool=${toolName} plugins=${this.plugins.length} cmd=${toolName === 'Bash' ? String(toolInput.command || '').slice(0, 100) : '...'}`);
                for (const plugin of this.plugins) {
                  if (plugin.canUseToolInterceptor) {
                    console.log(`[Hook] Running plugin interceptor: ${plugin.name || 'unnamed'}`);
                    const result = await plugin.canUseToolInterceptor(toolName, toolInput, sessionCtx);
                    console.log(`[Hook] Plugin result: ${JSON.stringify(result)?.slice(0, 200)}`);
                    if (result !== null && result !== undefined) {
                      if (result.behavior === "deny") {
                        console.log(`[Hook] PreToolUse DENIED by plugin: ${toolName}`);
                        return {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "deny",
                            permissionDecisionReason: result.message || "Blocked by plugin",
                          },
                        };
                      }
                      // Plugin explicitly allowed — continue to bash wrapping check
                      console.log(`[Hook] PreToolUse ALLOWED by plugin: ${toolName}`);
                      pluginAllowed = true;
                      break;
                    }
                  }
                }

                // Stop our file watcher before TaskOutput reads the same file
                if (toolName === "TaskOutput") {
                  console.log(`[Hook] PreToolUse TaskOutput — stopping bash watcher to avoid conflict`);
                  this._stopBashWatcher();
                  return { continue: true };
                }

                // Wrap Bash commands with tee for live streaming output
                if (toolName === "Bash" && toolInput.command) {
                  const toolUseId = input.tool_use_id || "unknown";
                  const outFile = `/tmp/claude-bash-${toolUseId}.log`;
                  try { fs.writeFileSync(outFile, ""); } catch {}
                  const wrapped = `set -o pipefail; (${toolInput.command}) 2>&1 | stdbuf -oL tee ${outFile}`;
                  console.log(`[Hook] Bash tee: toolUseId=${toolUseId} outFile=${outFile}`);
                  // Log the updatedInput to verify it's being applied
                  const result = {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "allow" as const,
                      updatedInput: { command: wrapped },
                    },
                  };
                  console.log(`[Hook] Bash returning updatedInput command length=${wrapped.length}`);
                  return result;
                }

                // No modification needed — allow
                if (pluginAllowed) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                    },
                  };
                }
                return { continue: true };
              }],
            }],
            SubagentStart: [{
              hooks: [async (input: any) => {
                try {
                  const agentId = input.agent_id || "";
                  const agentType = input.agent_type || "";
                  console.log(`[Hook] SubagentStart: agentId=${agentId} type=${agentType}`);
                } catch {}
                return { continue: true };
              }],
            }],
            SubagentStop: [{
              hooks: [async (input: any) => {
                try {
                  const agentId = input.agent_id || "";
                  const agentType = input.agent_type || "";
                  console.log(`[Hook] SubagentStop: agentId=${agentId} type=${agentType}`);
                } catch {}
                return { continue: true };
              }],
            }],
            SessionStart: [{
              hooks: [async (input: any) => {
                try {
                  const source = input.source || "unknown";
                  const model = input.model || "";
                  const agentType = input.agent_type || "";
                  console.log(`[Hook] SessionStart: source=${source} model=${model} agentType=${agentType}`);
                  if (model) this._sessionModel = model;
                  if (model) this.persistAgentSettings({ model });
                  this.send({
                    type: "session_lifecycle",
                    event: "start",
                    source,
                    model: model || undefined,
                    agentType: agentType || undefined,
                    sessionId: this.sessionId || "",
                  } as any);
                  // Persist in history for restore on session resume
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "assistant",
                      content: `[session_lifecycle:start:${source}${model ? ':' + model : ''}]`,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch {}
                return { continue: true };
              }],
            }],
            SessionEnd: [{
              hooks: [async (input: any) => {
                try {
                  const reason = input.reason || "unknown";
                  console.log(`[Hook] SessionEnd: reason=${reason}`);
                  this.send({
                    type: "session_lifecycle",
                    event: "end",
                    reason,
                    sessionId: this.sessionId || "",
                  } as any);
                  // Persist in history for restore on session resume
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "assistant",
                      content: `[session_lifecycle:end:${reason}]`,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch {}
                return { continue: true };
              }],
            }],
            TaskCreated: [{
              hooks: [async (input: any) => {
                try {
                  const taskId = input.task_id || "";
                  const subject = input.task_subject || "";
                  const description = input.task_description || "";
                  const teammateName = input.teammate_name || "";
                  console.log(`[Hook] TaskCreated: id=${taskId} subject=${subject}`);
                  this.send({
                    type: "task_created_hook",
                    taskId,
                    subject,
                    description: description || undefined,
                    teammateName: teammateName || undefined,
                    sessionId: this.sessionId || "",
                  } as any);
                } catch {}
                return { continue: true };
              }],
            }],
            TaskCompleted: [{
              hooks: [async (input: any) => {
                try {
                  const taskId = input.task_id || "";
                  const subject = input.task_subject || "";
                  const description = input.task_description || "";
                  const teammateName = input.teammate_name || "";
                  console.log(`[Hook] TaskCompleted: id=${taskId} subject=${subject} desc=${description?.slice(0, 80)}`);
                  this.send({
                    type: "task_completed_hook",
                    taskId,
                    subject,
                    description: description || undefined,
                    teammateName: teammateName || undefined,
                    sessionId: this.sessionId || "",
                  } as any);
                } catch {}
                return { continue: true };
              }],
            }],
          },
          stderr: (data: string) => {
            const trimmed = data.trimEnd();
            if (trimmed) {
              // Filter out SDK internal errors (stream closing race conditions).
              // The CLI dumps multi-line source context between the header and the
              // trailing `error: Stream closed`, so we match across newlines.
              if (/Error in hook callback.*Stream closed/is.test(trimmed)
                  || /^error: Stream closed\b[\s\S]*at sendRequest/i.test(trimmed)) {
                console.warn(`[Claude stderr] (suppressed SDK hook error) ${trimmed.slice(0, 100)}`);
                return;
              }
              console.error(`[Claude stderr] ${trimmed}`);
              // Forward stderr as streaming tool output to the app
              this.send({
                type: "tool_stderr",
                content: trimmed,
                sessionId: this.sessionId || "",
              } as any);
            }
          },
          canUseTool: async (toolName, input, { signal, suggestions, blockedPath, decisionReason, toolUseID, agentID } = {} as any) => {
            console.log(`canUseTool called: ${toolName}${agentID ? ` (agent: ${agentID})` : ''}${decisionReason ? ` reason: ${decisionReason}` : ''}`);

            // NOTE: Plugin interceptors run in PreToolUse hook (not here).
            // In bypassPermissions mode, canUseTool is only called for interactive tools.

            if (toolName === "AskUserQuestion") {
              const qId = `q${++this.questionCounter}`;
              const questions: QuestionItem[] = [];
              const inputQuestions = (input as any).questions;

              if (Array.isArray(inputQuestions)) {
                for (const q of inputQuestions) {
                  questions.push({
                    question: q.question || "",
                    header: q.header,
                    options: Array.isArray(q.options)
                      ? q.options.map((o: any) => ({
                          label: o.label || "",
                          description: o.description,
                          preview: o.preview || undefined,
                        }))
                      : [],
                    multiSelect: q.multiSelect,
                  });
                }
              }

              const questionMsg: ServerMessage = {
                type: "question",
                questionId: qId,
                questions,
                sessionId: this.sessionId || "",
                agentId: agentID || undefined,
                decisionReason: decisionReason || undefined,
              } as any;
              this.send(questionMsg);

              // Persist to history so questions survive reconnects
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "question",
                  content: "",
                  questionId: qId,
                  questions,
                  timestamp: new Date().toISOString(),
                });
              }

              const answers = await new Promise<Record<string, string>>(
                (resolve) => {
                  this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: questionMsg });
                }
              );

              return {
                behavior: "allow" as const,
                updatedInput: { ...input, answers },
              };
            }

            // Intercept ExitPlanMode — show plan to user for approval
            if (toolName === "ExitPlanMode") {
              // Use planFilePath from SDK input (v0.2.76+), fall back to directory search
              const planFilePath = (input as any).planFilePath;
              let planContent = "";
              try {
                if (planFilePath && fs.existsSync(planFilePath)) {
                  planContent = fs.readFileSync(planFilePath, "utf-8");
                  console.log(`[Plan] Read plan from SDK planFilePath: ${planFilePath}`);
                } else {
                  // Fallback: search plans directory for most recent .md file
                  const homeDir = process.env.HOME || require("os").homedir();
                  const plansDir = path.join(homeDir, ".claude", "plans");
                  if (fs.existsSync(plansDir)) {
                    const files = fs.readdirSync(plansDir)
                      .filter(f => f.endsWith(".md"))
                      .map(f => ({
                        name: f,
                        mtime: fs.statSync(path.join(plansDir, f)).mtimeMs,
                      }))
                      .sort((a, b) => b.mtime - a.mtime);
                    if (files.length > 0) {
                      planContent = fs.readFileSync(
                        path.join(plansDir, files[0].name), "utf-8"
                      );
                    }
                  }
                }
              } catch (e) {
                console.error(`[Plan] Error reading plan file: ${e}`);
              }

              const qId = `q${++this.questionCounter}`;
              const planQuestions: QuestionItem[] = [
                {
                  question: planContent || "Claude has proposed a plan. Approve or reject?",
                  header: "Plan Review",
                  options: [
                    { label: "Approve", description: "Accept this plan and proceed with implementation" },
                    { label: "Reject", description: "Reject this plan" },
                  ],
                  multiSelect: false,
                },
              ];
              const questionMsg: ServerMessage = {
                type: "question",
                questionId: qId,
                questions: planQuestions,
                sessionId: this.sessionId || "",
              };
              this.send(questionMsg);

              // Persist to history so plan reviews survive reconnects
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "question",
                  content: "",
                  questionId: qId,
                  questions: planQuestions,
                  timestamp: new Date().toISOString(),
                });
              }

              const answers = await new Promise<Record<string, string>>(
                (resolve) => {
                  this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: questionMsg });
                }
              );

              const firstAnswer = Object.values(answers)[0] || "";
              if (firstAnswer.toLowerCase().includes("approve")) {
                // Notify app that we're exiting plan mode
                this.send({
                  type: "permission_mode_changed",
                  permissionMode: "bypassPermissions",
                  sessionId: this.sessionId || "",
                } as any);
                return { behavior: "allow" as const, updatedInput: input };
              } else {
                return { behavior: "deny" as const, message: "User rejected the plan." };
              }
            }

            return { behavior: "allow" as const, updatedInput: input };
          },
          onElicitation: async (request: any, { signal }: { signal: AbortSignal }) => {
            const { serverName, message, mode, url, elicitationId, requestedSchema } = request;
            console.log(`[Elicitation] server=${serverName} mode=${mode || 'form'} msg=${message?.slice(0, 100)}`);

            if (mode === 'url' && url) {
              // URL-mode: send a dedicated card so the app can open the URL
              const qId = `elicit_${++this.questionCounter}`;
              const elicitMsg: ServerMessage = {
                type: "elicitation_url",
                questionId: qId,
                mcpServerName: serverName,
                message: message || `${serverName} requires authentication`,
                url,
                elicitationId: elicitationId || undefined,
                sessionId: this.sessionId || "",
              } as any;
              this.send(elicitMsg);

              // Persist to history so it survives session resume
              if (this.sessionId) {
                appendHistory(this.sessionId, {
                  role: "elicitation_url",
                  content: message || `${serverName} requires authentication`,
                  questionId: qId,
                  mcpServerName: serverName,
                  url,
                  timestamp: new Date().toISOString(),
                });
              }

              // Wait for user to complete the URL flow or cancel
              const answers = await new Promise<Record<string, string>>((resolve) => {
                this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: elicitMsg });
              });
              const action = Object.values(answers)[0] || "";
              if (action.toLowerCase().includes("cancel") || action.toLowerCase().includes("decline")) {
                return { action: "decline" as const };
              }
              return { action: "accept" as const };
            }

            // Form-mode: convert requestedSchema to QuestionItems and use question card
            const qId = `elicit_${++this.questionCounter}`;
            const questions: QuestionItem[] = [];

            if (requestedSchema && typeof requestedSchema === 'object') {
              const props = (requestedSchema as any).properties || {};
              const required = (requestedSchema as any).required || [];
              for (const [key, schema] of Object.entries(props) as [string, any][]) {
                const desc = schema.description || key;
                const isRequired = required.includes(key);
                const options: { label: string; description?: string }[] = [];
                // If the schema has enum values, create options for them
                if (Array.isArray(schema.enum)) {
                  for (const val of schema.enum) {
                    options.push({ label: String(val) });
                  }
                }
                questions.push({
                  question: `${desc}${isRequired ? ' (required)' : ''}`,
                  header: key,
                  options,
                  multiSelect: false,
                });
              }
            }

            // Fallback if no schema properties: single text input with the message
            if (questions.length === 0) {
              questions.push({
                question: message || `${serverName} is requesting input`,
                options: [],
                multiSelect: false,
              });
            }

            const questionMsg: ServerMessage = {
              type: "question",
              questionId: qId,
              questions,
              sessionId: this.sessionId || "",
              mcpServerName: serverName,
            } as any;
            this.send(questionMsg);

            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "question",
                content: "",
                questionId: qId,
                questions,
                timestamp: new Date().toISOString(),
              });
            }

            const answers = await new Promise<Record<string, string>>((resolve) => {
              this.pendingQuestions.set(qId, { questionId: qId, resolve, questionData: questionMsg });
            });

            // Check if user cancelled
            const firstAnswer = Object.values(answers)[0] || "";
            if (firstAnswer.toLowerCase() === "cancel" || firstAnswer.toLowerCase() === "decline") {
              return { action: "decline" as const };
            }

            // Map answers back to the schema structure
            const content: Record<string, string | number | boolean | string[]> = {};
            if (requestedSchema && (requestedSchema as any).properties) {
              const props = (requestedSchema as any).properties;
              for (const [key] of Object.entries(props)) {
                if (answers[key] !== undefined) {
                  content[key] = answers[key];
                }
              }
            } else {
              // Single-field fallback
              const val = Object.values(answers)[0];
              if (val) content["value"] = val;
            }

            return { action: "accept" as const, content };
          },
        },
      });

      let currentText = "";
      let lastResultContent = "";
      const now = () => new Date().toISOString();

      // SDK event persistence: coalesce content block deltas independently for
      // the main agent and every concurrently streaming subagent.
      const sdkBlocks = new Map<string, {
        text: string;
        index: number | null;
        type: string | null;
        toolName: string | null;
        toolUseId: string | null;
        deltaCount: number;
      }>();

      // Track per-turn usage from stream events to get current context size
      let lastTurnInputTokens = 0;
      let lastTurnOutputTokens = 0;
      let lastTurnCacheReadTokens = 0;
      let lastTurnCacheCreateTokens = 0;

      const initialTurnPromise = this._trackPendingTurn();

      // Log the user prompt to history (for resumed sessions we already have the ID)
      let promptLogged = false;
      if (this.sessionId || resumeSessionId) {
        const sid = this.sessionId || resumeSessionId || "";
        appendHistory(sid, {
          role: "user",
          content: prompt,
          uuid: userMsgUuid,
          timestamp: now(),
        });
        // Forward UUID to app right away so the rewind affordance shows on the
        // bubble without waiting for an SDK echo.
        this.send({
          type: "user_message_uuid",
          uuid: userMsgUuid,
          sessionId: sid,
        } as any);
        promptLogged = true;
      }

      const consumeQuery = async () => {
        try {
          for await (const message of q) {
        // Debug: log all message types to understand SDK event flow
        const msgType = message.type;
        const subtype = (message as any).subtype || (message as any).event?.type || '';
        if (msgType === 'stream_event') {
          const evt = (message as any).event;
          if (evt?.type && evt.type !== 'content_block_delta' && evt.type !== 'message_start' && evt.type !== 'message_delta') {
            console.log(`[SDK stream] event=${evt.type} ${JSON.stringify(evt).slice(0, 200)}`);
          }
        } else if (msgType === 'tool_progress') {
          const tp = message as any;
          console.log(`[SDK msg] type=tool_progress tool=${tp.tool_name} elapsed=${tp.elapsed_time_seconds}s id=${tp.tool_use_id}`);
        } else {
          console.log(`[SDK msg] type=${msgType} subtype=${subtype}`);
        }

        // Forward raw SDK event to app for debug mode + persist to JSONL
        try {
          const sdkPayload: any = { type: "sdk_event", sdkType: msgType };
          if (msgType === "stream_event") {
            const evt = (message as any).event;
            sdkPayload.event = evt;

            // Coalesced persistence: accumulate deltas, write on block_stop
            const sid = this.sessionId;
            if (sid && evt) {
              const evtType = evt.type;
              const blockKey = `${this._streamKey(message)}:${evt.index ?? "current"}`;
              if (evtType === "content_block_start") {
                const cb = evt.content_block || {};
                sdkBlocks.set(blockKey, {
                  text: "",
                  index: evt.index ?? null,
                  type: cb.type || null,
                  toolName: cb.name || null,
                  toolUseId: cb.id || null,
                  deltaCount: 0,
                });
              } else if (evtType === "content_block_delta") {
                const block = sdkBlocks.get(blockKey) || {
                  text: "",
                  index: evt.index ?? null,
                  type: null,
                  toolName: null,
                  toolUseId: null,
                  deltaCount: 0,
                };
                const delta = evt.delta || {};
                if (delta.type === "text_delta") block.text += delta.text || "";
                else if (delta.type === "input_json_delta") block.text += delta.partial_json || "";
                else if (delta.type === "thinking_delta") block.text += delta.thinking || "";
                block.deltaCount++;
                sdkBlocks.set(blockKey, block);
              } else if (evtType === "content_block_stop") {
                const block = sdkBlocks.get(blockKey);
                if (block) {
                  // Write coalesced content block entry
                  appendSdkEvent(sid, {
                    ts: now(),
                    sdkType: "content_block",
                    blockIndex: block.index,
                    blockType: block.type,
                    toolName: block.toolName,
                    toolUseId: block.toolUseId,
                    text: block.text,
                    deltaCount: block.deltaCount,
                  });
                  // Persist thinking blocks to chat history
                  if (block.type === "thinking" && block.text.length > 0) {
                    appendHistory(sid, {
                      role: "assistant",
                      content: block.text,
                      thinking: true,
                      parentToolUseId: (message as any).parent_tool_use_id || null,
                      uuid: (message as any).uuid || undefined,
                      timestamp: now(),
                    });
                  }
                  sdkBlocks.delete(blockKey);
                }
              } else if (evtType === "message_start") {
                const msg2 = evt.message || {};
                appendSdkEvent(sid, {
                  ts: now(),
                  sdkType: "message_start",
                  model: msg2.model,
                  usage: msg2.usage,
                });
              } else if (evtType === "message_delta") {
                appendSdkEvent(sid, {
                  ts: now(),
                  sdkType: "message_delta",
                  usage: evt.usage,
                  stopReason: evt.delta?.stop_reason,
                });
              } else if (evtType === "message_stop") {
                appendSdkEvent(sid, { ts: now(), sdkType: "message_stop" });
              }
            }
          } else {
            // Shallow copy, skip huge fields
            const raw = message as any;
            sdkPayload.subtype = raw.subtype;
            if (raw.session_id) sdkPayload.sessionId = raw.session_id;
            // assistant/user messages store content under .message.content
            const contentSource = raw.content || raw.message?.content;
            if (contentSource) {
              const blocks = Array.isArray(contentSource) ? contentSource : [];
              sdkPayload.blocks = blocks.map((b: any) => {
                if (b.type === "text") return { type: "text", text: b.text?.slice(0, 200) };
                if (b.type === "tool_use") return { type: "tool_use", name: b.name, id: b.id };
                if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content.slice(0, 200) : '(structured)' };
                return { type: b.type };
              });
            }
            if (raw.tool_name) sdkPayload.toolName = raw.tool_name;
            if (raw.tool_use_id) sdkPayload.toolUseId = raw.tool_use_id;
            if (raw.elapsed_time_seconds) sdkPayload.elapsed = raw.elapsed_time_seconds;
            if (raw.duration_ms) sdkPayload.durationMs = raw.duration_ms;
            if (raw.cost_usd) sdkPayload.cost = raw.cost_usd;
            if (raw.num_turns) sdkPayload.numTurns = raw.num_turns;
            if (raw.is_error) sdkPayload.isError = raw.is_error;
            if (raw.model_usage) sdkPayload.modelUsage = raw.model_usage;
            // System event fields
            if (raw.status) sdkPayload.status = raw.status;
            if (raw.compact_metadata) sdkPayload.compactMetadata = raw.compact_metadata;
            if (raw.task_id) sdkPayload.taskId = raw.task_id;
            if (raw.summary) sdkPayload.summary = raw.summary?.slice(0, 300);
            if (raw.trigger) sdkPayload.trigger = raw.trigger;

            // Persist non-stream events directly
            const sid = this.sessionId;
            if (sid) {
              appendSdkEvent(sid, { ts: now(), ...sdkPayload, type: undefined });
            }
          }
          this.send(sdkPayload as any);
        } catch (_) {}

        if (message.type === "system" && (message as any).subtype === "init") {
          this.sessionId = message.session_id;
          const replacesSessionId = this.replacesSessionId;
          this.send({
            type: "session_created",
            sessionId: message.session_id,
            ...(replacesSessionId ? { replacesSessionId } : {}),
            cwd: this.cwd,
          });

          if (replacesSessionId) {
            // Context was cleared — remap old session ID to this new one
            remapSession(replacesSessionId, message.session_id);
            this.replacesSessionId = undefined;
          } else if (!resumeSessionId) {
            const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "");
            const sessionInfo: SessionInfo = {
              id: message.session_id,
              title,
              cwd: this.cwd,
              createdAt: new Date().toISOString(),
              lastActive: new Date().toISOString(),
              messagePreview: "",
              backend: "claude",
              agentSettings: this.getAgentSettings(),
            };
            saveSession(sessionInfo);
          }

          this.send({
            type: "session_settings",
            sessionId: message.session_id,
            settings: this.getAgentSettings(),
          } as any);

          // Forward init data to app (available agents, tools, MCP servers, model, etc.)
          const initMsg = message as any;
          const initPermissionMode = initMsg.permissionMode as string | undefined;
          if (initPermissionMode) {
            this._permissionMode = initPermissionMode;
            const session = getSession(this.sessionId || "");
            if (session) {
              session.permissionMode = initPermissionMode;
              saveSession(session);
            }
            if (!resumeSessionId && this.sessionId) {
              appendHistory(this.sessionId, {
                role: "permission_mode",
                content: "",
                permissionMode: initPermissionMode,
                timestamp: new Date().toISOString(),
              });
            }
          }
          this._lastSessionInit = {
            type: "session_init",
            agents: initMsg.agents || undefined,
            tools: initMsg.tools || undefined,
            mcpServers: initMsg.mcp_servers || undefined,
            model: initMsg.model || undefined,
            claudeCodeVersion: initMsg.claude_code_version || undefined,
            permissionMode: initPermissionMode || undefined,
            sessionId: this.sessionId || "",
          } as any;
          this.send(this._lastSessionInit!);

          // Query available models and forward to app for model picker
          if (this.activeQuery) {
            this.activeQuery.supportedModels().then((models: any) => {
              if (models) {
                this._lastSupportedModels = {
                  type: "supported_models",
                  models,
                  sessionId: this.sessionId || "",
                } as any;
                this.send(this._lastSupportedModels!);
              }
            }).catch((e: any) => {
              console.error(`[Init] Failed to get supported models: ${e}`);
            });

            // Query available commands and agents (#18)
            // Wrapped in try-catch: older SDK versions may not have these methods,
            // and a synchronous TypeError would crash the message processing loop.
            try {
              console.log(`[Init] Querying supportedCommands...`);
              this.activeQuery.supportedCommands().then((commands: any) => {
                console.log(`[Init] supportedCommands returned: ${Array.isArray(commands) ? commands.length + ' commands' : typeof commands}`);
                if (commands && Array.isArray(commands) && commands.length > 0) {
                  this._lastSupportedCommands = {
                    type: "supported_commands",
                    commands,
                    sessionId: this.sessionId || "",
                  } as any;
                  this.send(this._lastSupportedCommands!);
                }
              }).catch((e: any) => {
                console.error(`[Init] Failed to get supported commands: ${e}`);
              });
            } catch (e) {
              console.warn(`[Init] supportedCommands not available: ${e}`);
            }

            try {
              console.log(`[Init] Querying supportedAgents...`);
              this.activeQuery.supportedAgents().then((agents: any) => {
                console.log(`[Init] supportedAgents returned: ${Array.isArray(agents) ? agents.length + ' agents' : typeof agents}`);
                if (agents && Array.isArray(agents) && agents.length > 0) {
                  this._lastSupportedAgents = {
                    type: "supported_agents",
                    agents,
                    sessionId: this.sessionId || "",
                  } as any;
                  this.send(this._lastSupportedAgents!);
                }
              }).catch((e: any) => {
                console.error(`[Init] Failed to get supported agents: ${e}`);
              });
            } catch (e) {
              console.warn(`[Init] supportedAgents not available: ${e}`);
            }

            // Fetch initial context usage
            this.activeQuery.getContextUsage().then((ctx: any) => {
              if (ctx) {
                this.send({
                  type: "context_usage",
                  sessionId: this.sessionId || "",
                  ...ctx,
                } as any);
                if (this.sessionId) updateSessionContextUsage(this.sessionId, ctx);
              }
            }).catch(() => {});
          }

          // Log user prompt now that we have the session ID (for new sessions)
          if (!promptLogged) {
            appendHistory(message.session_id, {
              role: "user",
              content: prompt,
              uuid: userMsgUuid,
              timestamp: now(),
            });
            // Forward UUID once we know which session it belongs to.
            this.send({
              type: "user_message_uuid",
              uuid: userMsgUuid,
              sessionId: message.session_id,
            } as any);
            promptLogged = true;
          }
        }

        // Forward tool_progress to the app — shows elapsed time while tools run
        if (message.type === "tool_progress") {
          const tp = message as any;
          this.send({
            type: "tool_progress",
            toolUseId: tp.tool_use_id || "",
            toolName: tp.tool_name || "",
            elapsedSeconds: tp.elapsed_time_seconds || 0,
            sessionId: this.sessionId || "",
            parentToolUseId: tp.parent_tool_use_id || null,
            uuid: tp.uuid || undefined,
          } as any);
        }

        // Forward files_persisted events — tells the app which files were written
        if (message.type === "system" && (message as any).subtype === "files_persisted") {
          const fp = message as any;
          console.log(`[SDK] Files persisted: ${fp.files?.length || 0} files, ${fp.failed?.length || 0} failed`);
          this.send({
            type: "files_persisted",
            files: fp.files || [],
            failed: fp.failed || [],
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward auth status changes (authenticating state)
        if (message.type === "auth_status") {
          const auth = message as any;
          console.log(`[SDK] Auth status: isAuthenticating=${auth.isAuthenticating}`);
          this.send({
            type: "auth_status",
            isAuthenticating: auth.isAuthenticating || false,
            output: auth.output || [],
            error: auth.error || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        // Detect context compaction status changes
        if (message.type === "system" && (message as any).subtype === "status") {
          const status = (message as any).status as string | null;
          const permMode = (message as any).permissionMode as string | undefined;
          console.log(`[SDK] Status change: ${status}${permMode ? ` permissionMode=${permMode}` : ''}`);
          this._isCompacting = status === "compacting";
          if (this._isCompacting) {
            this._compactStartedAt ||= new Date().toISOString();
          } else {
            this._compactStartedAt = null;
          }
          this.send({
            type: "compacting",
            active: this._isCompacting,
            sessionId: this.sessionId || "",
          } as any);
          // Forward permission mode changes (e.g., entering/exiting plan mode)
          if (permMode) {
            const previousMode = this._permissionMode;
            this._permissionMode = permMode;
            if (previousMode !== permMode) {
              this.persistPermissionMode(permMode);
            }
            this.send({
              type: "permission_mode_changed",
              permissionMode: permMode,
              sessionId: this.sessionId || "",
            } as any);
          }
        }

        // Forward compact boundary events (token count before compaction)
        if (message.type === "system" && (message as any).subtype === "compact_boundary") {
          const meta = (message as any).compact_metadata || {};
          console.log(`[SDK] Compact boundary: trigger=${meta.trigger} preTokens=${meta.pre_tokens}`);
          this.send({
            type: "compact_boundary",
            trigger: meta.trigger || "auto",
            preTokens: meta.pre_tokens || 0,
            sessionId: this.sessionId || "",
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "assistant",
              content: `[compact_boundary:${meta.pre_tokens || 0}:${meta.trigger || "auto"}]`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Forward background task notifications (type=system, subtype=task_notification)
        if (message.type === "system" && (message as any).subtype === "task_notification") {
          const tn = message as any;
          const sdkTaskId = tn.task_id || "";
          // Prefer SDK's direct tool_use_id, fall back to our mapping
          const originToolUseId = tn.tool_use_id || this._taskIdToToolUseId.get(sdkTaskId) || undefined;
          const parentToolUseId = originToolUseId
            ? this._toolParentIds.get(originToolUseId)
            : undefined;
          console.log(`[SDK] Task notification: id=${sdkTaskId} status=${tn.status} originToolUseId=${originToolUseId} summary=${tn.summary?.slice(0, 80)}`);
          // If this task was being monitored, flush output and send final notification
          if (sdkTaskId && this._monitoredTasks.has(sdkTaskId)) {
            const mState = this._monitoredTasks.get(sdkTaskId)!;
            this._stopMonitorReader(sdkTaskId);
            // Read any remaining output
            try {
              if (fs.existsSync(mState.outputFile)) {
                const fStat = fs.statSync(mState.outputFile);
                if (fStat.size > mState.lastSize) {
                  const mFd = fs.openSync(mState.outputFile, "r");
                  const mBuf = Buffer.alloc(fStat.size - mState.lastSize);
                  fs.readSync(mFd, mBuf, 0, mBuf.length, mState.lastSize);
                  fs.closeSync(mFd);
                  const remaining = mBuf.toString("utf8").split("\n").filter(l => l.length > 0);
                  if (remaining.length > 0) mState.outputBuffer.push(...remaining);
                }
              }
            } catch {}
            if (mState.outputBuffer.length > 0) {
              this._flushMonitorBuffer(sdkTaskId);
            }
            const exitMsg = `[Monitor: "${mState.description}" (${sdkTaskId})] Process ${tn.status || "completed"}. ${tn.summary || ""}`;
            if (this._isRunning && this.activeQuery) {
              this.injectMessage(exitMsg, 'next').catch(() => {});
            } else if (this.onMonitorOutput) {
              this.onMonitorOutput(exitMsg);
            }
            this._cleanupMonitor(sdkTaskId, false);
          }

          // Read full output file before cleaning up (for history persistence)
          let bgOutputContent = "";
          const bgOutputFile = tn.output_file || (sdkTaskId ? this._taskOutputFiles.get(sdkTaskId) : undefined);
          if (bgOutputFile) {
            try {
              if (fs.existsSync(bgOutputFile)) {
                bgOutputContent = fs.readFileSync(bgOutputFile, "utf-8");
              }
            } catch {}
          }

          if (sdkTaskId) this._taskIdToToolUseId.delete(sdkTaskId);
          if (sdkTaskId) this._taskOutputFiles.delete(sdkTaskId);
          if (sdkTaskId) this._stopBgBashWatcher(sdkTaskId);

          // Persist the full output as the tool_result for the bash card in history
          if (bgOutputContent && originToolUseId && this.sessionId) {
            appendHistory(this.sessionId, {
              role: "tool_result",
              content: "",
              toolUseId: originToolUseId,
              toolOutput: bgOutputContent,
              parentToolUseId: parentToolUseId || null,
              timestamp: new Date().toISOString(),
            });
          }

          this.send({
            type: "task_notification",
            taskId: sdkTaskId,
            status: tn.status || "completed",
            outputFile: bgOutputFile || undefined,
            summary: tn.summary || "",
            originToolUseId,
            parentToolUseId: parentToolUseId || null,
            sessionId: this.sessionId || "",
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "notification",
              content: tn.summary || `Task ${tn.status}`,
              status: tn.status || "completed",
              originToolUseId,
              parentToolUseId: parentToolUseId || null,
              timestamp: new Date().toISOString(),
            });
          }
          if (originToolUseId) this._toolParentIds.delete(originToolUseId);
        }

        // Handle tool use summaries — clean human-readable summaries of tool groups
        if (message.type === "tool_use_summary") {
          const summary = message as any;
          console.log(`[SDK] Tool use summary: ${summary.summary?.slice(0, 100)}`);
          this.send({
            type: "tool_summary",
            summary: summary.summary || "",
            precedingToolUseIds: summary.preceding_tool_use_ids || [],
            parentToolUseId: summary.parent_tool_use_id || null,
            sessionId: this.sessionId || "",
            uuid: summary.uuid || undefined,
          } as any);
          if (this.sessionId) {
            appendHistory(this.sessionId, {
              role: "assistant",
              content: summary.summary || "",
              toolSummary: true,
              precedingToolUseIds: summary.preceding_tool_use_ids || [],
              parentToolUseId: summary.parent_tool_use_id || null,
              uuid: summary.uuid || undefined,
              timestamp: now(),
            });
          }
        }

        // Forward rate limit events to app (#7)
        if (message.type === "rate_limit_event") {
          const info = (message as any).rate_limit_info || {};
          console.log(`[SDK] Rate limit raw: ${JSON.stringify((message as any).rate_limit_info)}`);
          this.send({
            type: "rate_limit_event",
            status: info.status || "allowed",
            resetsAt: info.resetsAt || undefined,
            utilization: info.utilization || undefined,
            rateLimitType: info.rateLimitType || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward background task lifecycle events (#8, #9)
        if (message.type === "system" && (message as any).subtype === "task_started") {
          const ts = message as any;
          console.log(`[SDK] Task started: id=${ts.task_id} toolUseId=${ts.tool_use_id} desc=${ts.description} type=${ts.task_type}`);
          // Build task_id ↔ tool_use_id mapping (replaces regex agentId extraction)
          if (ts.task_id && ts.tool_use_id) {
            this._taskIdToToolUseId.set(ts.task_id, ts.tool_use_id);
            const subagent = this._activeSubagents.get(ts.tool_use_id);
            if (subagent) subagent.agentId = ts.task_id;
          }
          this.send({
            type: "task_started",
            taskId: ts.task_id || "",
            toolUseId: ts.tool_use_id || undefined,
            description: ts.description || "",
            taskType: ts.task_type || undefined,
            prompt: ts.prompt || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        if (message.type === "system" && (message as any).subtype === "task_progress") {
          const tp = message as any;
          const toolUseId = tp.tool_use_id || this._taskIdToToolUseId.get(tp.task_id) || undefined;
          console.log(`[SDK] Task progress: id=${tp.task_id} toolUseId=${toolUseId} tool=${tp.last_tool_name} summary=${tp.summary?.slice(0, 60)}`);
          this.send({
            type: "bg_task_progress",
            taskId: tp.task_id || "",
            toolUseId,
            description: tp.description || "",
            usage: tp.usage || undefined,
            lastToolName: tp.last_tool_name || undefined,
            summary: tp.summary || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward API retry events (#10 — defensive, needs SDK v0.2.77+)
        if (message.type === "system" && (message as any).subtype === "api_retry") {
          const ar = message as any;
          console.log(`[SDK] API retry: attempt=${ar.attempt}/${ar.max_retries} delay=${ar.delay_ms}ms`);
          this.send({
            type: "api_retry",
            attempt: ar.attempt || 0,
            maxRetries: ar.max_retries || 0,
            delayMs: ar.delay_ms || 0,
            errorStatus: ar.error_status || undefined,
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward hook lifecycle messages
        if (message.type === "system" && (message as any).subtype === "hook_started") {
          const hs = message as any;
          console.log(`[SDK] Hook started: ${hs.hook_name} (${hs.hook_event})`);
          this.send({
            type: "hook_started",
            hookId: hs.hook_id || "",
            hookName: hs.hook_name || "",
            hookEvent: hs.hook_event || "",
            sessionId: this.sessionId || "",
          } as any);
        }

        if (message.type === "system" && (message as any).subtype === "hook_progress") {
          const hp = message as any;
          this.send({
            type: "hook_progress",
            hookId: hp.hook_id || "",
            hookName: hp.hook_name || "",
            hookEvent: hp.hook_event || "",
            stdout: hp.stdout || "",
            stderr: hp.stderr || "",
            sessionId: this.sessionId || "",
          } as any);
        }

        if (message.type === "system" && (message as any).subtype === "hook_response") {
          const hr = message as any;
          console.log(`[SDK] Hook response: ${hr.hook_name} (${hr.hook_event}) outcome=${hr.outcome}`);
          this.send({
            type: "hook_response",
            hookId: hr.hook_id || "",
            hookName: hr.hook_name || "",
            hookEvent: hr.hook_event || "",
            stdout: hr.stdout || "",
            stderr: hr.stderr || "",
            exitCode: hr.exit_code,
            outcome: hr.outcome || "success",
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward session state changes (idle/running/requires_action)
        if (message.type === "system" && (message as any).subtype === "session_state_changed") {
          const sc = message as any;
          const state = sc.state || "idle";
          console.log(`[SDK] Session state: ${state}`);
          this.send({
            type: "session_state_changed",
            state,
            sessionId: this.sessionId || "",
            ...(this.activeStartedAt ? { activeStartedAt: this.activeStartedAt } : {}),
          } as any);
        }

        // Forward CWD changes to app
        if (message.type === "system" && (message as any).subtype === "cwd_changed") {
          const cc = message as any;
          const oldCwd = cc.old_cwd || "";
          const newCwd = cc.new_cwd || cc.cwd || "";
          if (newCwd) {
            console.log(`[SDK] CWD changed: ${oldCwd} → ${newCwd}`);
            this.cwd = newCwd;
            this.send({
              type: "cwd_changed",
              oldCwd,
              newCwd,
              sessionId: this.sessionId || "",
            } as any);
            // Persist to history for restore on resume
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "assistant",
                content: `[cwd_changed:${newCwd}]`,
                timestamp: new Date().toISOString(),
              });
            }
            // Update session store
            const sessionInfo = this.sessionId ? getSession(this.sessionId) : undefined;
            if (sessionInfo) {
              sessionInfo.cwd = newCwd;
              saveSession(sessionInfo);
            }
          }
        }

        // Forward local command output (#11)
        if (message.type === "system" && (message as any).subtype === "local_command_output") {
          const lco = message as any;
          console.log(`[SDK] Local command output: ${lco.content?.slice(0, 80)}`);
          this.send({
            type: "local_command_output",
            content: lco.content || "",
            sessionId: this.sessionId || "",
          } as any);
        }

        // Forward prompt suggestions (#12)
        if (message.type === "prompt_suggestion") {
          const ps = message as any;
          const suggestion = ps.suggestion || "";
          console.log(`[SDK] Prompt suggestion: ${suggestion.slice(0, 80)}`);
          this.send({
            type: "prompt_suggestion",
            suggestion,
            sessionId: this.sessionId || "",
          } as any);
          // Persist in session history so it can be restored on resume
          if (this.sessionId && suggestion) {
            appendHistory(this.sessionId, {
              role: "prompt_suggestion",
              content: suggestion,
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            const parentToolUseId = (message as any).parent_tool_use_id || null;
            if (!parentToolUseId) currentText += event.delta.text;
            const streamId = this._appendLiveStream(
              this._streamingText,
              message,
              event.delta.text,
            );
            this._streamingThinking.delete(streamId);
            this.send({
              type: "text",
              content: event.delta.text,
              sessionId: this.sessionId || "",
              streamId,
              parentToolUseId,
              uuid: (message as any).uuid || undefined,
            });
          }

          // Stream thinking deltas to client
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "thinking_delta"
          ) {
            const streamId = this._appendLiveStream(
              this._streamingThinking,
              message,
              event.delta.thinking || "",
            );
            this.send({
              type: "thinking",
              content: event.delta.thinking || "",
              sessionId: this.sessionId || "",
              streamId,
              parentToolUseId: (message as any).parent_tool_use_id || null,
              uuid: (message as any).uuid || undefined,
            });
          }

          // Track per-turn usage from message_start (input tokens for this turn)
          if (
            !(message as any).parent_tool_use_id &&
            event?.type === "message_start" &&
            event.message?.usage
          ) {
            const u = event.message.usage;
            lastTurnInputTokens = u.input_tokens || 0;
            lastTurnCacheReadTokens = u.cache_read_input_tokens || 0;
            lastTurnCacheCreateTokens = u.cache_creation_input_tokens || 0;
            lastTurnOutputTokens = 0; // Reset, will be set by message_delta
            console.log(`[Usage] message_start: input=${lastTurnInputTokens} cacheRead=${lastTurnCacheReadTokens} cacheCreate=${lastTurnCacheCreateTokens}`);
            // Send mid-query usage update to the app
            this.send({
              type: "usage_update",
              inputTokens: lastTurnInputTokens,
              outputTokens: 0,
              cacheReadTokens: lastTurnCacheReadTokens,
              cacheCreateTokens: lastTurnCacheCreateTokens,
              contextWindow: this._lastContextWindow,
              sessionId: this.sessionId || "",
            } as any);
          }

          // Track output tokens from message_delta (end of turn)
          if (
            !(message as any).parent_tool_use_id &&
            event?.type === "message_delta" &&
            event.usage
          ) {
            lastTurnOutputTokens = event.usage.output_tokens || 0;
            console.log(`[Usage] message_delta: output=${lastTurnOutputTokens}`);
            // Send updated usage with output tokens so the app can display them in real-time
            this.send({
              type: "usage_update",
              inputTokens: lastTurnInputTokens,
              outputTokens: lastTurnOutputTokens,
              cacheReadTokens: lastTurnCacheReadTokens,
              cacheCreateTokens: lastTurnCacheCreateTokens,
              contextWindow: this._lastContextWindow,
              sessionId: this.sessionId || "",
            } as any);
          }
        }

        if (message.type === "assistant") {
          // Surface per-message error types (rate_limit, auth_failed, billing_error, etc.)
          const assistantError = (message as any).error;
          if (assistantError) {
            console.error(`[SDK] Assistant error: ${assistantError}`);
            if (assistantError === 'authentication_failed') {
              this._authErrorSent = true;
              this._startAuthLogin().then((url) => {
                if (url) {
                  this.send({
                    type: "claude_auth",
                    url,
                    sessionId: this.sessionId || "",
                  } as any);
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "assistant",
                      content: `[claude_auth:${url}]`,
                      timestamp: now(),
                    });
                  }
                } else {
                  this.send({
                    type: "error",
                    message: `Authentication failed. Run \`claude auth login\` on the server to re-authenticate.`,
                    errorType: assistantError,
                    sessionId: this.sessionId || "",
                  } as any);
                }
              }).catch(() => {
                this.send({
                  type: "error",
                  message: `Authentication failed. Run \`claude auth login\` on the server to re-authenticate.`,
                  errorType: assistantError,
                  sessionId: this.sessionId || "",
                } as any);
              });
            } else {
              this.send({
                type: "error",
                message: `Assistant error: ${assistantError}`,
                errorType: assistantError,
                sessionId: this.sessionId || "",
              } as any);
            }
          }

          // Only close the stream that produced this assistant message. Other
          // subagents can still be streaming concurrently.
          this._clearLiveStreamsForMessage(message);
          // Log the full assistant text once the message is complete
          // Skip persisting the raw error text when auth login is being handled
          const apiMessage = (message as any).message;
          console.log(`[SDK] Assistant message: content_blocks=${apiMessage?.content?.length || 0} types=${apiMessage?.content?.map((b: any) => b.type).join(',') || 'none'}`);
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            // Extract full text from assistant message
            const textParts = apiMessage.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text);
            if (textParts.length > 0) {
              if (!(message as any).parent_tool_use_id) {
                this._lastPreview = textParts.join("").slice(0, 200);
              }
              this.onActivity?.();
              if (this.sessionId && !this._authErrorSent) {
                appendHistory(this.sessionId, {
                  role: "assistant",
                  content: textParts.join(""),
                  parentToolUseId: (message as any).parent_tool_use_id || null,
                  uuid: (message as any).uuid || undefined,
                  timestamp: now(),
                });
              }
            }

            for (const block of apiMessage.content) {
              if (block.type === "tool_use") {
                if ((message as any).parent_tool_use_id) {
                  this._toolParentIds.set(block.id, (message as any).parent_tool_use_id);
                }
                // Don't send AskUserQuestion as a tool_call — it's handled
                // via canUseTool and rendered as a proper question card
                if (block.name === "AskUserQuestion") {
                  this._suppressedToolResultIds.add(block.id);
                  continue;
                }

                // Intercept TodoWrite — diff against stored state, only send if changed
                if (block.name === "TodoWrite") {
                  this._suppressedToolResultIds.add(block.id);
                  const todos = (block.input as any)?.todos;
                  if (Array.isArray(todos)) {
                    const prev = this.sessionId ? getTodos(this.sessionId) : [];
                    const changed = todos.length !== prev.length ||
                      todos.some((t: any, i: number) =>
                        t.content !== prev[i]?.content || t.status !== prev[i]?.status);
                    if (this.sessionId) {
                      saveTodos(this.sessionId, todos);
                    }
                    if (changed) {
                      this.send({
                        type: "todos",
                        todos,
                        sessionId: this.sessionId || "",
                      } as any);
                    }
                  }
                  continue;
                }

                // Send MCP tool calls (Speak, SendFile, ScheduleReminder) for UI display
                const mcpName = block.name.replace("mcp__app__", "");
                if (mcpName === "Speak" || mcpName === "SendFile" || mcpName === "ScheduleReminder") {
                  this.send({
                    type: "tool_call",
                    tool: mcpName,
                    input: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                    sessionId: this.sessionId || "",
                    parentToolUseId: (message as any).parent_tool_use_id || null,
                    uuid: (message as any).uuid || undefined,
                  });
                  if (this.sessionId) {
                    appendHistory(this.sessionId, {
                      role: "tool_call",
                      content: "",
                      toolName: mcpName,
                      toolInput: block.input as Record<string, unknown>,
                      toolUseId: block.id,
                      parentToolUseId: (message as any).parent_tool_use_id || null,
                      uuid: (message as any).uuid || undefined,
                      timestamp: now(),
                    });
                  }
                  continue;
                }

                console.log(`[SDK] >>> tool_call: ${block.name} toolUseId=${block.id}`);
                // Track the currently-executing tool call
                this._activeToolUseId = block.id;
                this._activeToolName = block.name;
                this.send({
                  type: "tool_call",
                  tool: block.name,
                  input: block.input as Record<string, unknown>,
                  toolUseId: block.id,
                  sessionId: this.sessionId || "",
                  parentToolUseId: (message as any).parent_tool_use_id || null,
                  uuid: (message as any).uuid || undefined,
                });

                // Update preview with tool call description
                const inp = block.input as Record<string, unknown>;
                const previewDesc = (inp.file_path as string) || (inp.command as string) || (inp.pattern as string) || (inp.query as string) || (inp.prompt as string) || "";
                this._lastPreview = `[${block.name}] ${previewDesc}`.slice(0, 200);
                this.onActivity?.();

                // Track Read tool file paths for image extraction
                if (block.name === "Read") {
                  const filePath = (block.input as any)?.file_path || "";
                  if (filePath) {
                    this._readToolPaths.set(block.id, filePath);
                  }
                }

                // Start watching the global bash log file for streaming output
                // Start watching for bash output — file path derived from tool_use_id
                // (matches the path the PreToolUse hook uses for tee wrapping)
                if (block.name === "Bash") {
                  this._startBashWatcher(`/tmp/claude-bash-${block.id}.log`);
                }

                // Track all Agent (subagent) tool calls (renamed from "Task" in SDK 0.2.76)
                if (block.name === "Agent" || block.name === "Task") {
                  const desc = (block.input as any)?.description || "Agent";
                  const subagentType = (block.input as any)?.subagent_type || "";
                  const mappedAgentId = Array.from(this._taskIdToToolUseId.entries())
                    .find(([, mappedToolUseId]) => mappedToolUseId === block.id)?.[0];
                  this._activeSubagents.set(block.id, {
                    ...(mappedAgentId ? { agentId: mappedAgentId } : {}),
                    toolUseId: block.id,
                    description: desc,
                    subagentType,
                    startedAt: now(),
                    ...((message as any).parent_tool_use_id
                      ? { parentToolUseId: (message as any).parent_tool_use_id }
                      : {}),
                  });
                  console.log(`[SDK] Subagent started: ${desc} (toolUseId=${block.id}, type=${subagentType})`);

                  // Background task notification (immediate UI feedback before task_started arrives)
                  if ((block.input as any)?.run_in_background) {
                    console.log(`[SDK] Background task launched: ${desc} (toolUseId=${block.id})`);
                    this.send({
                      type: "task_notification",
                      taskId: block.id,
                      status: "started",
                      summary: desc,
                      originToolUseId: block.id,
                      parentToolUseId: (message as any).parent_tool_use_id || null,
                      sessionId: this.sessionId || "",
                    } as any);
                  }
                }

                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_call",
                    content: "",
                    toolName: block.name,
                    toolInput: block.input as Record<string, unknown>,
                    toolUseId: block.id,
                    parentToolUseId: (message as any).parent_tool_use_id || null,
                    uuid: (message as any).uuid || undefined,
                    timestamp: now(),
                  });
                }
              }
            }
          }
        }

        if (message.type === "user") {
          // Forward user message UUID to app for rewind support
          // Only for real user prompts, not synthetic tool result messages
          const userMsgUuid = (message as any).uuid || undefined;
          const isSynthetic = (message as any).isSynthetic || (message as any).tool_use_result != null;
          if (userMsgUuid && !isSynthetic) {
            this.send({
              type: "user_message_uuid",
              uuid: userMsgUuid,
              sessionId: this.sessionId || "",
            } as any);
            // Store UUID directly on the user history entry (not as a separate entry)
            if (this.sessionId) {
              assignUserUuid(this.sessionId, userMsgUuid);
            }
          }
          const apiMessage = (message as any).message;
          if (apiMessage?.content && Array.isArray(apiMessage.content)) {
            for (const block of apiMessage.content) {
              if (block.type === "tool_result") {
                const toolUseId = block.tool_use_id || "";

                // Skip results for suppressed tools (TodoWrite, AskUserQuestion)
                if (this._suppressedToolResultIds.has(toolUseId)) {
                  this._suppressedToolResultIds.delete(toolUseId);
                  continue;
                }

                const output =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("\n")
                      : JSON.stringify(block.content);

                // Extract image blocks from tool results (e.g., Read on image files)
                if (Array.isArray(block.content)) {
                  for (const c of block.content as any[]) {
                    if (c.type === "image" && c.source?.type === "base64") {
                      const sourcePath = this._readToolPaths.get(toolUseId) || "";
                      const mimeType = c.source.media_type || "image/png";
                      let filePath = sourcePath;
                      try {
                        const bytes = Buffer.from(c.source.data, "base64");
                        if (this.sessionId) {
                          filePath = cacheToolImage(
                            this.sessionId,
                            toolUseId,
                            bytes,
                            mimeType,
                            sourcePath,
                          );
                        }
                      } catch (err: any) {
                        console.warn(`[SDK] Failed to cache tool image: ${err?.message || String(err)}`);
                      }
                      console.log(`[SDK] Image block found in tool result: ${sourcePath || toolUseId}`);
                      this.send({
                        type: "tool_image",
                        toolUseId,
                        imageData: c.source.data,
                        mimeType,
                        filePath,
                        sessionId: this.sessionId || "",
                      });
                      // Persist file path reference to history (NOT the base64 data)
                      if (this.sessionId) {
                        appendHistory(this.sessionId, {
                          role: "tool_image",
                          content: "",
                          toolUseId,
                          filePath,
                          mimeType,
                          timestamp: now(),
                        });
                      }
                    }
                  }
                  // Clean up tracked path
                  this._readToolPaths.delete(toolUseId);
                }

                // Detect bash command moved to background (timeout)
                const bgMatch = output.match(/Command running in background with ID: (\S+)\. Output is being written to: (\S+)/);
                if (bgMatch && this._activeBashStream) {
                  const bgTaskId = bgMatch[1];
                  const outputFile = bgMatch[2];
                  console.log(`[SDK] Bash moved to background: taskId=${bgTaskId}, outputFile=${outputFile}, toolUseId=${toolUseId}`);

                  // Track output file for Monitor toggle mode
                  this._taskOutputFiles.set(bgTaskId, outputFile);

                  // Stop the active bash watcher (will be replaced by next tool's watcher)
                  this._stopBashWatcher();

                  // Start an independent watcher that survives next tool calls
                  this._startBgBashWatcher(bgTaskId, toolUseId, outputFile);

                  // Send a background notification so the app tracks it
                  this.send({
                    type: "bash_backgrounded",
                    toolUseId,
                    taskId: bgTaskId,
                    outputFile,
                    sessionId: this.sessionId || "",
                  } as any);

                  // task_id ↔ tool_use_id mapping handled by task_started SDK message

                  // Don't replace card content — just send the tool_result normally
                  // but the app will handle it specially
                } else {
                  // Stop bash output watcher — tool finished normally
                  this._stopBashWatcher();
                }

                // Remove completed subagent from active tracking. Keep its
                // parent mapping until the SDK task notification arrives.
                let completedSubagent = false;
                if (this._activeSubagents.has(toolUseId)) {
                  completedSubagent = true;
                  const info = this._activeSubagents.get(toolUseId)!;
                  console.log(`[SDK] Subagent completed: ${info.description} (toolUseId=${toolUseId})`);
                  this._activeSubagents.delete(toolUseId);
                }

                // Clear active tool tracking — tool has completed
                this._activeToolUseId = null;
                this._activeToolName = null;

                // Stream large tool output in chunks for progressive rendering
                const CHUNK_THRESHOLD = 500; // Only chunk if output > 500 chars
                const CHUNK_SIZE = 200; // ~200 chars per chunk (roughly 3-4 lines)
                const parentId = (message as any).parent_tool_use_id || null;
                const msgUuid = (message as any).uuid || undefined;
                if (output.length > CHUNK_THRESHOLD) {
                  const numChunks = Math.ceil(output.length / CHUNK_SIZE);
                  console.log(`[SDK] <<< tool_result_chunk: toolUseId=${toolUseId} len=${output.length} chunks=${numChunks}`);
                  let chunkIdx = 0;
                  for (let i = 0; i < output.length; i += CHUNK_SIZE) {
                    this.send({
                      type: "tool_result_chunk",
                      toolUseId,
                      chunkIndex: chunkIdx++,
                      content: output.slice(i, i + CHUNK_SIZE),
                      done: i + CHUNK_SIZE >= output.length,
                      sessionId: this.sessionId || "",
                      parentToolUseId: parentId,
                    } as any);
                  }
                } else {
                  console.log(`[SDK] <<< tool_result: toolUseId=${toolUseId} len=${output.length}`);
                  this.send({
                    type: "tool_result",
                    toolUseId,
                    output,
                    sessionId: this.sessionId || "",
                    parentToolUseId: parentId,
                    uuid: msgUuid,
                  });
                }
                if (this.sessionId) {
                  appendHistory(this.sessionId, {
                    role: "tool_result",
                    content: "",
                    toolUseId: block.tool_use_id || "",
                    toolOutput: output,
                    parentToolUseId: parentId,
                    uuid: msgUuid,
                    timestamp: now(),
                  });
                }
                if (!bgMatch && !completedSubagent) {
                  this._toolParentIds.delete(toolUseId);
                }
              }
            }
          }
        }

        if (message.type === "result") {
          const result = message as any;
          const resultParentId = result.parent_tool_use_id || null;
          if (resultParentId) {
            console.log(`[SDK] Subagent result (parent_tool_use_id=${resultParentId}), subtype=${result.subtype}, cost=${result.total_cost_usd}, turns=${result.num_turns}`);
            // Send as subagent_result so the app can track it without mistaking it for the main query result
            this.send({
              type: "subagent_result",
              parentToolUseId: resultParentId,
              content: result.result || "",
              costUsd: result.total_cost_usd,
              durationMs: result.duration_ms,
              numTurns: result.num_turns,
              stopReason: result.stop_reason || undefined,
              subtype: result.subtype || undefined,
              terminalReason: result.terminal_reason || undefined,
              sessionId: this.sessionId || "",
            } as any);
            continue;
          }
          lastResultContent =
            result.result || currentText || "Task completed.";
          console.log(`[SDK] Result: subtype=${result.subtype} num_turns=${result.num_turns} result_len=${result.result?.length || 0} currentText_len=${currentText.length}`);

          // For slash commands / local commands: if result has content but no text
          // was streamed during this query, send the result as a text message
          if (result.result && !currentText) {
            console.log(`[SDK] Slash command result: ${result.result.slice(0, 100)}`);
            this.send({
              type: "text",
              content: result.result,
              sessionId: this.sessionId || "",
            });
            if (this.sessionId) {
              appendHistory(this.sessionId, {
                role: "assistant",
                content: result.result,
                timestamp: now(),
              });
            }
          }

          // Use last turn's per-turn usage (from stream events) for current context size.
          // modelUsage contains cumulative totals across ALL turns — not useful for context fill.
          let contextWindow = 0;
          if (result.modelUsage) {
            for (const model of Object.values(result.modelUsage) as any[]) {
              if (model.contextWindow > contextWindow) {
                contextWindow = model.contextWindow;
              }
            }
          }
          // Cache contextWindow for mid-query usage updates in future queries
          if (contextWindow > 0) {
            this._lastContextWindow = contextWindow;
          }
          console.log(`[Usage] Last turn: input=${lastTurnInputTokens} output=${lastTurnOutputTokens} cacheRead=${lastTurnCacheReadTokens} cacheCreate=${lastTurnCacheCreateTokens} contextWindow=${contextWindow}`);

          const usageInfo = {
            inputTokens: lastTurnInputTokens,
            outputTokens: lastTurnOutputTokens,
            cacheReadTokens: lastTurnCacheReadTokens,
            cacheCreateTokens: lastTurnCacheCreateTokens,
            contextWindow,
          };

          // Total usage across ALL turns (from SDK result.usage)
          const totalUsage = result.usage ? {
            inputTokens: result.usage.inputTokens || 0,
            outputTokens: result.usage.outputTokens || 0,
            cacheReadTokens: result.usage.cacheReadInputTokens || 0,
            cacheCreateTokens: result.usage.cacheCreationInputTokens || 0,
            costUsd: result.usage.costUSD || 0,
          } : undefined;

          this.send({
            type: "result",
            content: lastResultContent,
            sessionId: this.sessionId || "",
            costUsd: result.total_cost_usd,
            durationMs: result.duration_ms,
            durationApiMs: result.duration_api_ms || undefined,
            usage: usageInfo,
            totalUsage,
            numTurns: result.num_turns,
            stopReason: result.stop_reason || undefined,
            resultSubtype: result.subtype || undefined,
            terminalReason: result.terminal_reason || undefined,
            fastModeState: result.fast_mode_state || undefined,
            errors: result.errors?.length ? result.errors : undefined,
            permissionDenials: result.permission_denials?.length ? result.permission_denials : undefined,
          });

          this._lastPreview = lastResultContent.slice(0, 200);

          if (this.sessionId) {
            const usageWithCost = usageInfo
              ? { ...usageInfo, costUsd: result.total_cost_usd, numTurns: result.num_turns }
              : undefined;
            updateSessionActivity(this.sessionId, lastResultContent, usageWithCost);
          }

          // Fetch detailed context usage breakdown from SDK (async, non-blocking)
          if (this.activeQuery) {
            this.activeQuery.getContextUsage().then((ctx: any) => {
              if (ctx) {
                this.send({
                  type: "context_usage",
                  sessionId: this.sessionId || "",
                  ...ctx,
                } as any);
                if (this.sessionId) updateSessionContextUsage(this.sessionId, ctx);
              }
            }).catch(() => {});
          }

          this._isRunning = false;
          this._runStartedAt = null;
          if (CLAUDE_WARM_IDLE_TIMEOUT_MS > 0) {
            this._enterWarmIdle();
          } else {
            this.activeInputQueue?.close();
            try { this.activeQuery?.close(); } catch {}
          }
          this._resolvePendingTurn();
          this.onActivity?.();
          currentText = "";
        }
      }
    } catch (err: any) {
      const errMsg = err.message || "Unknown error during query";
      console.error("Query error:", errMsg);
      if (err.stack) console.error(err.stack);
      this._rejectPendingTurns(new Error(errMsg));

      // Skip if we already sent a login URL for this auth failure
      if (!this._authErrorSent) {
        this.send({
          type: "error",
          message: errMsg,
        });
      }
    } finally {
      this._leaveWarmIdle();
      this._isRunning = false;
      this._isWarmIdle = false;
      this._isCompacting = false;
      this._runStartedAt = null;
      this._compactStartedAt = null;
      this.activeInputQueue?.close();
      this.activeInputQueue = null;
      this.activeQuery = null;
      this._rejectPendingTurns(new Error("Claude SDK stream closed"));
      this.onActivity?.();
      this.onClose?.();
    }
      };
      void consumeQuery();
      return initialTurnPromise;
    } catch (err: any) {
      const errMsg = err.message || "Unknown error starting query";
      console.error("Query setup error:", errMsg);
      if (err.stack) console.error(err.stack);
      this._leaveWarmIdle();
      this._isRunning = false;
      this._isWarmIdle = false;
      this._isCompacting = false;
      this._runStartedAt = null;
      this._compactStartedAt = null;
      this.activeInputQueue?.close();
      this.activeInputQueue = null;
      this.activeQuery = null;
      this._rejectPendingTurns(new Error(errMsg));
      if (!this._authErrorSent) {
        this.send({
          type: "error",
          message: errMsg,
        });
      }
      this.onActivity?.();
      this.onClose?.();
    }
  }

  /** Generate our own OAuth PKCE auth URL (no CLI subprocess needed). */
  private _startAuthLogin(): Promise<string | null> {
    this._authRequest = createClaudeAuthRequest();
    console.log(`[Auth] Generated OAuth URL: ${this._authRequest.authUrl}`);
    console.log(`[Auth] code_verifier: ${this._authRequest.codeVerifier.substring(0, 10)}...`);
    return Promise.resolve(this._authRequest.authUrl);
  }

  /** Exchange the OAuth code for tokens and save to ~/.claude/.credentials.json */
  submitAuthCode(code: string): void {
    console.log(`[Auth] submitAuthCode called — pending=${!!this._authRequest}`);
    if (!this._authRequest) {
      console.error("[Auth] No pending auth flow (missing code_verifier or state)");
      this.send({
        type: "error",
        message: "No pending login session. Try sending a message to trigger auth again.",
      });
      return;
    }

    const request = this._authRequest;
    exchangeClaudeAuthCode(request, code)
      .then(() => {
      console.log("[Auth] Saved Claude OAuth tokens");
      this._sendAuthResult(true);
    })
      .catch((e: any) => {
      console.error(`[Auth] Claude auth failed: ${e.message}`);
      this.send({ type: "error", message: `Authentication failed: ${e.message}` });
      this._sendAuthResult(false);
    });
  }

  private _sendAuthResult(success: boolean): void {
    this._authRequest = null;
    this.send({
      type: "claude_auth_result",
      success,
      sessionId: this.sessionId || "",
    } as any);
    if (this.sessionId) {
      appendHistory(this.sessionId, {
        role: "assistant",
        content: `[claude_auth_result:${success ? "success" : "failure"}]`,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
