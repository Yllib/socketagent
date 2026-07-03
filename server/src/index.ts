import * as dotenv from "dotenv";
const bootstrapPath = require("path") as typeof import("path");
const bootstrapFs = require("fs") as typeof import("fs");
const ENV_PATH = bootstrapPath.join(__dirname, "..", ".env");

function secureSecretFileMode(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    if (bootstrapFs.existsSync(filePath)) {
      bootstrapFs.chmodSync(filePath, 0o600);
    }
  } catch (e: any) {
    console.warn(`[Security] Failed to restrict permissions on ${filePath}: ${e.message || e}`);
  }
}

secureSecretFileMode(ENV_PATH);
dotenv.config({ path: ENV_PATH });

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { ClaudeSession, refreshClaudeExecutableInfo } from "./claude-session";
import { CODEX_NATIVE_SLASH_COMMANDS, CodexSession, archiveCodexAppServerThread, compactCodexAppServerThread, createSession, rollbackCodexAppServerThread, Session, detectAvailableBackends, getCodexAvailability, invalidateCodexAvailabilityCache, isCodexAuthError, unarchiveCodexAppServerThread } from "./codex-session";
import { listSessionsWithNativeBackends, getSession, saveSession, getHistory, getHistoryCount, getHistoryPage, getHistoryPageToLastPrompt, deleteSession, deleteSessionArtifacts, clearSessionContext, cleanupPendingToolCalls, compactHistoryStorage, getTodos, getMissedMessages, appendHistory, appendHistoryBulk, appendNativeHistorySuffix, updateSessionActivity, getSdkEvents, getSdkEventCount, markQuestionAnswered, getLastHistoryTimestamp, listSdkSessions, listCodexSessions, listCodexNativeSdkSessions, readCodexRolloutHistory, readCodexAppServerThreadHistory, getRecentCwds, addRecentCwd, removeRecentCwd, truncateHistoryAtMessage, getLastPromptSuggestion, listArchivesWithNativeCodex, getArchiveHistory, restoreArchive, restoreCodexNativeArchive, deleteArchive, isCodexThreadArchived, isCodexNativeArchiveTs, getCodexNativeThreadSessionInfo, getClaudeNativeSessionInfo, markSessionArchived, renameCodexNativeThread, invalidateCodexNativeListCache, findCodexRolloutFile, getJsonlPath } from "./session-store";
import { listScheduledTasks, getScheduledTask, saveScheduledTask, deleteScheduledTask, getDueTasks, getNextRunTime, getScheduledTaskSessionIds, ScheduledTask } from "./scheduled-task-store";
import { Backend, ClientMessage, CodexDriver, SessionInfo } from "./protocol";
import { SocketAgentPlugin, PluginContext } from "./plugin-api";
import { RelayClient, RelayStatus } from "./relay-client";
import { loadOrCreateKeyPair, toBase64 } from "./relay-crypto";
import { listSkills, getSkill, saveSkill, deleteSkill, listMarketplacePlugins, runPluginCommand, listMarketplaces, addMarketplace, updateMarketplace, removeMarketplace } from "./skills-manager";
import { handleCodexAppMcpRequest, isCodexAppMcpRequest } from "./codex-app-mcp";
import { clearBackendHealthOverride, getAdvertisedServerSettings, getDefaultCwd, invalidateBackendHealthCache, invalidateCodexDriverAvailabilityCache, markBackendAuthRequired, setDefaultCwd } from "./server-settings";
import { isPushConfigured, isPushTokenRegistered, registerPushToken, sendPushNotification, unregisterPushToken } from "./push-notifications";
import { assertFileManagerPathAllowed, getFileManagerRoots, listFileManagerDirectory, resolveFileManagerPath } from "./file-manager";
import { readProtectedFiles, removeMatchingProtection, setProtectedFile, writeProtectedFiles } from "./protected-files";
import { runBackendInstall } from "./backend-installer";
import { getProcessHome, resolveClientPath } from "./path-utils";
import { terminalSessionManager } from "./terminal-session";
import { cancelSecureInputRequest, completeSecureInputRequest, redactSecretsDeep, saveSecureInput } from "./secure-input-store";
import { socketAgentDataPath } from "./socket-agent-paths";
import { createClaudeAuthRequest, exchangeClaudeAuthCode, ClaudeAuthRequest } from "./claude-auth";

process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled rejection:", reason);
});

const PORT = parseInt(process.env.PORT || "8085", 10);
const BIND_HOST = (process.env.BIND_HOST || process.env.SOCKETAGENT_BIND_HOST || "127.0.0.1").trim() || "127.0.0.1";
type AppVersionInfo = { version: string; url: string };
const WS_QUEUE_WARN_MS = Number(process.env.SOCKETAGENT_WS_QUEUE_WARN_MS || 250);
const WS_HANDLER_WARN_MS = Number(process.env.SOCKETAGENT_WS_HANDLER_WARN_MS || 500);
const WS_SEND_WARN_MS = Number(process.env.SOCKETAGENT_WS_SEND_WARN_MS || 250);

function logSlowWs(label: string, startedAt: number, details: Record<string, unknown> = {}): void {
  const elapsedMs = Date.now() - startedAt;
  const threshold = label.includes("queue") ? WS_QUEUE_WARN_MS
    : label.includes("send") ? WS_SEND_WARN_MS
      : WS_HANDLER_WARN_MS;
  if (elapsedMs < threshold) return;
  const suffix = Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.warn(`[Perf] ${label} ms=${elapsedMs}${suffix ? ` ${suffix}` : ""}`);
}

function parseAppVersionInfo(raw: string): AppVersionInfo | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.version !== "string" || typeof parsed.url !== "string") {
      return null;
    }
    return { version: parsed.version, url: parsed.url };
  } catch {
    return null;
  }
}

function readLocalAppVersionInfo(): AppVersionInfo | null {
  if (!GIT_ROOT) return null;
  const file = path.join(GIT_ROOT, "app-version.json");
  if (!fs.existsSync(file)) return null;
  return parseAppVersionInfo(fs.readFileSync(file, "utf8"));
}

function readRemoteAppVersionInfo(branch: string): AppVersionInfo | null {
  if (!GIT_ROOT) return null;
  try {
    const raw = execFileSync("git", ["show", `origin/${branch}:app-version.json`], {
      cwd: GIT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseAppVersionInfo(raw);
  } catch {
    return null;
  }
}

function attachAppVersionInfo(info: Record<string, any>, appVersion: AppVersionInfo) {
  info.app = appVersion;
  // Backward compatibility for app builds that read version metadata directly
  // from the server version payload before app checks moved to GitHub.
  info.version = appVersion.version;
  info.url = appVersion.url;
}

function buildCwdCheck(rawPath: unknown, overrides: Record<string, any> = {}): Record<string, any> {
  const resolved = resolveClientPath(rawPath);
  const home = getProcessHome();
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    user = undefined;
  }

  const base = {
    type: "cwd_check",
    path: resolved.inputPath,
    expandedPath: resolved.expandedPath,
    resolvedPath: resolved.resolvedPath,
    exists: false,
    isDirectory: false,
    platform: process.platform,
    serverCwd: process.cwd(),
    home,
    user,
  };

  if (!resolved.inputPath) {
    return { ...base, error: "No path provided", ...overrides };
  }

  try {
    const stat = fs.statSync(resolved.resolvedPath);
    const isDirectory = stat.isDirectory();
    return {
      ...base,
      exists: true,
      isDirectory,
      error: isDirectory ? undefined : "Path exists but is not a directory",
      ...overrides,
    };
  } catch (e: any) {
    return {
      ...base,
      error: e?.message || String(e),
      errorCode: e?.code,
      ...overrides,
    };
  }
}

function sendCwdCheck(sendJson: (payload: any) => void, rawPath: unknown, overrides: Record<string, any> = {}): Record<string, any> {
  const payload = buildCwdCheck(rawPath, overrides);
  const ok = payload.exists === true && payload.isDirectory === true;
  const reason = payload.errorCode || payload.error || (payload.exists ? "not_directory" : "missing");
  console.log(`[cwd_check] ${ok ? "ok" : "fail"} path="${payload.path}" resolved="${payload.resolvedPath}" reason="${reason}" user="${payload.user || ""}" home="${payload.home || ""}"`);
  sendJson(payload);
  return payload;
}

function resolveAllowedDownloadFile(inputPath: string): { resolvedPath: string; stat: fs.Stats } {
  if (!inputPath) throw new Error("Missing path");
  const roots = getFileManagerRoots(getDefaultCwd());
  const resolvedPath = resolveFileManagerPath(inputPath, getDefaultCwd());
  assertFileManagerPathAllowed(resolvedPath, roots);
  if (!fs.existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolvedPath}`);
  return { resolvedPath, stat };
}

// ── .env migrations (run once on startup, before reading config) ──
(function migrateEnv() {
  const envPath = ENV_PATH;
  if (!fs.existsSync(envPath)) return;
  let content = fs.readFileSync(envPath, "utf-8");
  const migrations: [RegExp, string, string][] = [
    [/^RELAY_URL=ws:\/\/jarofdirt\.info:9988$/m, "RELAY_URL=wss://relay.jarofdirt.info", "relay URL to wss://relay.jarofdirt.info"],
  ];
  let changed = false;
  for (const [pattern, replacement, desc] of migrations) {
    if (pattern.test(content)) {
      content = content.replace(pattern, replacement);
      console.log(`[Migrate] Updated .env: ${desc}`);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(envPath, content, { mode: 0o600 });
    secureSecretFileMode(envPath);
    dotenv.config({ path: envPath, override: true });
  }
})();

const RELAY_URL = process.env.RELAY_URL || "";

// Auth token — read from .env or generate and persist one
let AUTH_TOKEN = process.env.AUTH_TOKEN || "";
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(32).toString("hex");
  const envPath = ENV_PATH;
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";
  fs.writeFileSync(envPath, existing.trimEnd() + `\nAUTH_TOKEN=${AUTH_TOKEN}\n`, { mode: 0o600 });
  secureSecretFileMode(envPath);
  console.log(`Generated new auth token. Add this to your app settings:`);
  console.log(`  Token: ${AUTH_TOKEN}`);
} else {
  console.log(`Auth token loaded from .env`);
}

// Pairing token for relay — read from .env or generate and persist one
let PAIRING_TOKEN = process.env.PAIRING_TOKEN || "";
if (RELAY_URL && !PAIRING_TOKEN) {
  PAIRING_TOKEN = crypto.randomUUID();
  const envPath = ENV_PATH;
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";
  fs.writeFileSync(envPath, existing.trimEnd() + `\nPAIRING_TOKEN=${PAIRING_TOKEN}\n`, { mode: 0o600 });
  secureSecretFileMode(envPath);
  console.log(`Generated new pairing token`);
}

// Load plugins from plugins/ directory
const plugins: SocketAgentPlugin[] = [];
const pluginsDir = path.join(__dirname, "..", "plugins");
if (fs.existsSync(pluginsDir)) {
  const files = fs.readdirSync(pluginsDir)
    .filter(f => f.endsWith(".js"))
    .filter(f => !f.endsWith(".d.js"));
  for (const file of files) {
    try {
      const mod = require(path.join(pluginsDir, file));
      const plugin: SocketAgentPlugin = mod.default || mod;
      if (plugin.name) {
        plugins.push(plugin);
        console.log(`Loaded plugin: ${plugin.name}`);
      }
    } catch (e: any) {
      console.error(`Failed to load plugin ${file}: ${e.message}`);
    }
  }
}

// Track all connected WebSocket clients for broadcasting
const connectedClients = new Set<WebSocket>();

// Global session registry — sessions survive client disconnects
const activeSessions: Map<string, Session> = new Map();

type BackendOperationKind = "repair" | "auth";
type ActiveBackendInstall = {
  requestId: string;
  operation: BackendOperationKind;
  abortController?: AbortController;
  sendProgress?: (progress: Record<string, unknown>) => void;
};

const activeBackendInstalls = new Map<Backend, ActiveBackendInstall>();
const pendingClaudeBackendAuth = new Map<string, {
  request: ClaudeAuthRequest;
  sendProgress: (progress: Record<string, unknown>) => void;
  timeout: NodeJS.Timeout;
}>();

function finishClaudeBackendAuth(requestId: string, progress: Record<string, unknown>): void {
  const pending = pendingClaudeBackendAuth.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingClaudeBackendAuth.delete(requestId);
  const active = activeBackendInstalls.get("claude");
  if (!active || active.requestId === requestId) {
    activeBackendInstalls.delete("claude");
  }
  invalidateBackendHealthCache();
  pending.sendProgress(progress);
  broadcastServerCapabilities();
}

// Sessions whose context has been cleared — next query should NOT pass resume
const clearedSessions: Set<string> = new Set();

function sessionIsBusy(session: Session): boolean {
  if (typeof (session as any).isBusy === "boolean") return (session as any).isBusy;
  return session.isRunning || (session as any).isCompacting === true;
}

function getSessionActiveStartedAt(session: Session): string | undefined {
  const value = (session as any).activeStartedAt;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionSuppressesOngoingNotification(session: Session): boolean {
  return (session as any)._suppressOngoingNotification === true;
}

function sessionShouldRemainPooled(session: Session): boolean {
  return Boolean((session as any)._authRequest || (session as any).isWarmIdle === true);
}

function describeActiveSessions(): string {
  return Array.from(activeSessions.entries())
    .map(([sid, session]) => `${sid}:${sessionIsBusy(session) ? "busy" : "idle"}`)
    .join(", ");
}

function autoUpdateBlockReason(): string | null {
  if (activeBackendInstalls.size > 0) {
    return `backend repair is running (${Array.from(activeBackendInstalls.keys()).join(", ")})`;
  }
  for (const [, session] of activeSessions) {
    if (sessionIsBusy(session)) {
      return `sessions are running (${describeActiveSessions()})`;
    }
  }
  return null;
}

// Track which WebSocket client is viewing which session, so the /continue
// endpoint can use the real WebSocket instead of a dummy when the app has
// already reconnected before the continue script runs.
interface SessionClient {
  ws: WebSocket;
  setActiveSession: (s: Session) => void;
}
const sessionClients = new Map<string, SessionClient>();

/** Enrich stored/native sessions with live data from active sessions */
async function getEnrichedSessions(): Promise<SessionInfo[]> {
  const sessions = await listSessionsWithNativeBackends();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const sid of activeSessions.keys()) {
    if (!byId.has(sid)) {
      const stored = getSession(sid);
      if (stored) byId.set(sid, stored);
    }
  }
  const taskSessionIds = getScheduledTaskSessionIds();
  return [...byId.values()]
    .filter(s => !taskSessionIds.has(s.id))
    .map(s => {
      const active = activeSessions.get(s.id);
      if (active && sessionIsBusy(active)) {
        const activeStartedAt = getSessionActiveStartedAt(active);
        return {
          ...s,
          running: true,
          ...(activeStartedAt ? { activeStartedAt } : {}),
          messagePreview: active.lastPreview || s.messagePreview,
          lastActive: new Date().toISOString(),
        };
      }
      return { ...s, running: false };
    });
}

/** Broadcast current session list to all connected clients immediately. */
async function broadcastSessionListNow(reason = "manual"): Promise<void> {
  const startedAt = Date.now();
  try {
    const enriched = await getEnrichedSessions();
    const stringifyStartedAt = Date.now();
    const msg = JSON.stringify({ type: "session_list", sessions: enriched });
    logSlowWs("ws_send_session_list_stringify", stringifyStartedAt, {
      reason,
      count: enriched.length,
      bytes: Buffer.byteLength(msg),
    });
    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
    // Also send to relay client if paired
    if (relayConnectionHandler) {
      relayConnectionHandler.sendRaw(msg);
    }
    logSlowWs("ws_send_session_list", startedAt, { reason, count: enriched.length });
  } catch (err: any) {
    console.warn(`[Sessions] failed to broadcast session list: ${err?.message || err}`);
  }
}

let sessionListBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let sessionListBroadcastAt = 0;
let sessionListBroadcastQueued = false;
let sessionListBroadcastInFlight = false;

function flushSessionListBroadcast(reason: string): void {
  sessionListBroadcastTimer = null;
  sessionListBroadcastAt = 0;
  if (sessionListBroadcastInFlight) {
    sessionListBroadcastQueued = true;
    broadcastSessionList(250, `${reason}:queued`);
    return;
  }
  if (!sessionListBroadcastQueued) return;

  sessionListBroadcastQueued = false;
  sessionListBroadcastInFlight = true;
  broadcastSessionListNow(reason)
    .catch((err: any) => {
      console.warn(`[Sessions] failed to flush session list: ${err?.message || err}`);
    })
    .finally(() => {
      sessionListBroadcastInFlight = false;
      if (sessionListBroadcastQueued) {
        broadcastSessionList(250, `${reason}:again`);
      }
    });
}

/** Coalesced session-list broadcast. Explicit list_sessions requests remain immediate. */
function broadcastSessionList(delayMs = 500, reason = "update"): void {
  sessionListBroadcastQueued = true;
  const targetAt = Date.now() + Math.max(0, delayMs);
  if (sessionListBroadcastTimer && targetAt >= sessionListBroadcastAt) return;
  if (sessionListBroadcastTimer) clearTimeout(sessionListBroadcastTimer);
  sessionListBroadcastAt = targetAt;
  sessionListBroadcastTimer = setTimeout(
    () => flushSessionListBroadcast(reason),
    Math.max(0, targetAt - Date.now()),
  );
}

/** Broadcast scheduled task list to all connected clients */
function broadcastScheduledTaskList(): void {
  const msg = JSON.stringify({ type: "scheduled_task_list", tasks: listScheduledTasks() });
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relayConnectionHandler) relayConnectionHandler.sendRaw(msg);
}

function relayPairingInfo(): { relayUrl: string; pairingToken: string; serverPubkey: string } | undefined {
  if (!RELAY_URL || !PAIRING_TOKEN) return undefined;
  const keysPath = socketAgentDataPath("relay-keys.json");
  const keyPair = loadOrCreateKeyPair(keysPath);
  return {
    relayUrl: publicRelayUrl(RELAY_URL),
    pairingToken: PAIRING_TOKEN,
    serverPubkey: toBase64(keyPair.publicKey),
  };
}

function publicRelayUrl(relayUrl: string): string {
  try {
    const url = new URL(relayUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      return process.env.PUBLIC_RELAY_URL || "wss://relay.jarofdirt.info";
    }
  } catch {}
  return relayUrl;
}

function serverCapabilitiesPayload(binaryEnvelope = true): Record<string, unknown> {
  const settings = getAdvertisedServerSettings();
  return {
    type: "server_capabilities",
    binaryEnvelope,
    terminal: true,
    backends: detectAvailableBackends(),
    codexDriver: settings.codexDriver,
    codexDriversAvailable: settings.codexDriversAvailable,
    backendHealth: settings.backendHealth,
    relayPairing: relayPairingInfo(),
    pushNotifications: {
      directFcm: true,
      configured: isPushConfigured(),
    },
  };
}

function broadcastServerCapabilities(): void {
  const msg = JSON.stringify(serverCapabilitiesPayload(true));
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relayConnectionHandler) relayConnectionHandler.sendRaw(msg);
}

function shouldSendPushNotification(): boolean {
  return true;
}

function maybeSendPushNotification(msg: {
  type: "scheduled_task_notification";
  title: string;
  body: string;
  sessionId: string;
  status?: "completed" | "failed" | "manual";
}): void {
  if (!shouldSendPushNotification()) return;
  sendPushNotification({
    title: msg.title,
    body: msg.body,
    sessionId: msg.sessionId,
    status: msg.status || "manual",
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for session=${msg.sessionId || "none"} title=${msg.title.slice(0, 80)}`);
    }
  }).catch((err) => {
    console.warn(`[Push] FCM push error: ${err?.message || err}`);
  });
}

function notificationText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return fallback;
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function sessionNotificationTitle(sessionId: string, session: Session): string {
  const info = getSession(sessionId);
  const title = info?.title?.trim();
  if (title && title !== "Untitled") return notificationText(title, "SocketAgent");
  const cwd = info?.cwd || session.getCwd?.() || "";
  return notificationText(cwd ? path.basename(cwd) || cwd : "", "SocketAgent");
}

function storedSessionNotificationTitle(sessionId: string): string | undefined {
  const info = getSession(sessionId);
  if (!info) return undefined;
  const title = info.title?.trim();
  if (title && title !== "Untitled") return notificationText(title, "SocketAgent");
  const cwd = info.cwd || "";
  return notificationText(cwd ? path.basename(cwd) || cwd : "", "SocketAgent");
}

function sessionNotificationBody(sessionId: string, session: Session, fallback: string): string {
  const preview = (session as any).lastPreview || getSession(sessionId)?.messagePreview || "";
  return notificationText(preview, fallback);
}

const lastSessionStartedPush = new Map<string, string>();

function sendSessionStartedPush(session: Session): boolean {
  const sessionId = session.getSessionId?.();
  if (!sessionId) return false;
  const startedAt = getSessionActiveStartedAt(session) || new Date().toISOString();
  if (lastSessionStartedPush.get(sessionId) === startedAt) return true;
  lastSessionStartedPush.set(sessionId, startedAt);

  sendPushNotification({
    title: sessionNotificationTitle(sessionId, session),
    body: "Agent is working",
    sessionId,
    status: "running",
    kind: "session_started",
    data: { startedAt },
    showNotification: false,
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for prompt started session=${sessionId}`);
    }
  }).catch((err) => {
    console.warn(`[Push] Prompt started push error: ${err?.message || err}`);
  });
  return true;
}

function sendSessionCompletionPush(session: Session, status: "completed" | "failed", fallbackBody?: string): void {
  const sessionId = session.getSessionId?.();
  if (!sessionId) return;
  const title = sessionNotificationTitle(sessionId, session);
  const body = sessionNotificationBody(
    sessionId,
    session,
    fallbackBody || (status === "failed" ? "Prompt failed" : "Prompt complete")
  );
  sendPushNotification({
    title,
    body,
    sessionId,
    status,
    kind: "session_finished",
    data: { finishedAt: new Date().toISOString() },
    showNotification: false,
  }).then((result) => {
    if (result.attempted > 0) {
      console.log(`[Push] FCM sent ${result.sent}/${result.attempted} for prompt ${status} session=${sessionId}`);
    }
  }).catch((err) => {
    console.warn(`[Push] Prompt completion push error: ${err?.message || err}`);
  });
}

/** Broadcast a scheduled task notification to all connected clients */
function broadcastScheduledTaskNotification(
  title: string,
  body: string,
  sessionId: string,
  status: "completed" | "failed" | "manual",
  options: { sendPush?: boolean } = {},
): void {
  const payload = { type: "scheduled_task_notification" as const, title, body, sessionId, status };
  const msg = JSON.stringify(payload);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relayConnectionHandler) relayConnectionHandler.sendRaw(msg);
  if (options.sendPush !== false) maybeSendPushNotification(payload);
}

function forwardHeadlessScheduledAgentMessage(data: string, fallbackSessionId?: string): void {
  try {
    const msg = JSON.parse(data);
    if (msg?.type !== "scheduled_task_notification" && msg?.type !== "reminder") {
      return;
    }
    if (msg.type === "scheduled_task_notification" && !msg.sessionId && fallbackSessionId) {
      msg.sessionId = fallbackSessionId;
    }
    const raw = JSON.stringify(msg);
    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
    if (relayConnectionHandler) relayConnectionHandler.sendRaw(raw);
    if (msg.type === "scheduled_task_notification") {
      maybeSendPushNotification(msg);
    }
  } catch {
    // Ignore non-JSON or unrelated headless session traffic.
  }
}

function notifySessionActivity(): void {
  broadcastSessionList(2000, "activity");
  broadcastStatusSync();
}

function attachSessionLifecycleCallbacks(session: Session): void {
  session.onActivity = () => notifySessionActivity();
  (session as any).onClose = () => {
    let removed = false;
    if (!sessionShouldRemainPooled(session) && !sessionIsBusy(session)) {
      for (const [sid, active] of activeSessions.entries()) {
        if (active === session) {
          activeSessions.delete(sid);
          removed = true;
        }
      }
    }
    if (removed) {
      console.log(`[SessionPool] Removed closed idle session ${session.getSessionId?.() || "(unknown)"}`);
    }
    broadcastSessionList();
    broadcastStatusSync();
  };
}

function getStoredCodexDriver(sessionInfo: SessionInfo | undefined): CodexDriver | undefined {
  if (sessionInfo?.backend !== "codex") return undefined;
  return "app-server";
}

function isContextClearedSession(sessionInfo: SessionInfo | undefined, sessionId: string): boolean {
  return !!sessionInfo?.contextClearedAt || clearedSessions.has(sessionId);
}

async function syncCodexNativeHistory(sessionInfo: SessionInfo): Promise<any[]> {
  if (sessionInfo.backend !== "codex") return [];
  const rolloutAdded = syncCodexRolloutHistory(sessionInfo);
  if (rolloutAdded.length > 0) return rolloutAdded;
  const localHistory = getHistory(sessionInfo.id);
  let appServerHistory: any[] = [];
  if (localHistory.length === 0) {
    appServerHistory = await readCodexAppServerThreadHistory(sessionInfo.id);
  }
  const added = appendNativeHistorySuffix(sessionInfo.id, appServerHistory);
  if (added.length > 0) {
    console.log(`[CodexSync] Merged ${added.length} native suffix entries for ${sessionInfo.id}`);
    updateSessionActivity(
      sessionInfo.id,
      added[added.length - 1]?.content || sessionInfo.messagePreview || "",
    );
  }
  return added;
}

function syncCodexRolloutHistory(sessionInfo: SessionInfo): any[] {
  if (sessionInfo.backend !== "codex") return [];
  const rolloutHistory = readCodexRolloutHistory(sessionInfo.id);
  if (rolloutHistory.length === 0) return [];
  const added = appendNativeHistorySuffix(sessionInfo.id, rolloutHistory);
  if (added.length > 0) {
    console.log(`[CodexSync] Merged ${added.length} rollout entries for ${sessionInfo.id}`);
    updateSessionActivity(
      sessionInfo.id,
      added[added.length - 1]?.content || sessionInfo.messagePreview || "",
    );
  }
  return added;
}

const EXTERNAL_NATIVE_ACTIVE_TTL_MS = 15_000;
const externalNativeSessionActivity = new Map<string, number>();

function nativeHistoryPathForSession(sessionInfo: SessionInfo): string | null {
  if (sessionInfo.backend === "codex") {
    return findCodexRolloutFile(sessionInfo.id);
  }
  if (sessionInfo.backend === "claude" || !sessionInfo.backend) {
    const cwd = sessionInfo.cwd || getDefaultCwd();
    return cwd ? getJsonlPath(sessionInfo.id, cwd) : null;
  }
  return null;
}

function nativeHistoryFingerprintForSession(sessionInfo: SessionInfo): string | null {
  const file = nativeHistoryPathForSession(sessionInfo);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function nativeHistoryChangedSince(sessionInfo: SessionInfo, lastTimestamp: string | undefined): boolean {
  if (!lastTimestamp) return true;
  const lastMs = Date.parse(lastTimestamp);
  if (!Number.isFinite(lastMs)) return true;

  const file = nativeHistoryPathForSession(sessionInfo);
  if (!file) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    return stat.mtimeMs > lastMs + 1000;
  } catch {
    return false;
  }
}

function markExternalNativeSessionActive(sessionId: string): void {
  externalNativeSessionActivity.set(sessionId, Date.now() + EXTERNAL_NATIVE_ACTIVE_TTL_MS);
  broadcastStatusSync();
}

function getExternalNativeRunningSessions(now = Date.now()): string[] {
  const running: string[] = [];
  for (const [sessionId, activeUntil] of externalNativeSessionActivity) {
    if (activeUntil <= now) {
      externalNativeSessionActivity.delete(sessionId);
      continue;
    }
    running.push(sessionId);
  }
  return running;
}

function hasExternalNativeActivity(now = Date.now()): boolean {
  return getExternalNativeRunningSessions(now).length > 0;
}

function syncClaudeNativeHistory(sessionInfo: SessionInfo): any[] {
  const cwd = sessionInfo.cwd || getDefaultCwd();
  if (!cwd) return [];
  const lastTimestamp = getLastHistoryTimestamp(sessionInfo.id) || "1970-01-01T00:00:00Z";
  const added = getMissedMessages(sessionInfo.id, cwd, lastTimestamp);
  if (added.length > 0) {
    appendHistoryBulk(sessionInfo.id, added);
    updateSessionActivity(
      sessionInfo.id,
      added[added.length - 1]?.content || sessionInfo.messagePreview || "",
    );
  }
  return added;
}

function syncExternalNativeHistory(sessionInfo: SessionInfo): any[] {
  if (sessionInfo.backend === "codex") return syncCodexRolloutHistory(sessionInfo);
  if (sessionInfo.backend === "claude" || !sessionInfo.backend) return syncClaudeNativeHistory(sessionInfo);
  return [];
}

/**
 * Transport interface — abstracts over real WebSocket and relay virtual socket.
 * ClaudeSession needs readyState + send(). Connection handler needs send().
 */
interface ClientTransport {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  readonly connectionGeneration?: number;
  send(data: string): void;
}

function normalizeCodexPermissionMode(mode: unknown): string | null {
  if (mode === "superYolo" || mode === "bypassPermissions" || mode === "default" || mode === "plan") {
    return mode;
  }
  if (mode === "auto" || mode === "acceptEdits") {
    return "default";
  }
  return null;
}

async function restorePersistedPermissionMode(session: Session, sessionInfo?: SessionInfo): Promise<void> {
  if (sessionInfo?.backend !== "codex") return;
  const historyMode = sessionInfo.id
    ? [...getHistory(sessionInfo.id)]
        .reverse()
        .find((entry) => entry.role === "permission_mode")
        ?.permissionMode
    : undefined;
  const mode = normalizeCodexPermissionMode(sessionInfo.permissionMode || historyMode);
  if (mode) {
    await (session as any).setPermissionMode(mode, { recordHistory: false });
  }
}

/**
 * Per-connection state and message handler.
 * Used for both direct WebSocket connections and relay connections.
 */
function createConnectionHandler(transport: ClientTransport) {
  let activeSession: Session | null = null;
  let activeSessionId: string | null = null;
  let pendingTtsEnabled = false;
  let pendingTtsEngine: "system" | "kokoro_server" | "kokoro_device" = "system";
  let pendingKokoroVoice = "af_heart";
  let pendingKokoroSpeed = 1.0;
  let pendingEffort: 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh' = 'high';
  let pendingThinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } = { type: 'adaptive' };
  let pendingDisallowedTools: string[] = [];
  let pendingSystemPrompt: string = '';
  let pendingCodexCollaborationMode = 'default';
  let pendingCodexFastMode = false;
  let pendingClaudeAutoCompact = true;

  // Track active file uploads from the app
  const activeUploads = new Map<string, {
    fd: number;
    filePath: string;
    fileName: string;
    receivedChunks: number;
    totalChunks: number;
    chunkSize: number;
    totalBytes: number;
    bytesReceived: number;
    lastProgressEmit: number;
	  }>();
  const activeFileSendVersions = new Map<string, number>();
  let externalNativeWatchTimer: ReturnType<typeof setInterval> | null = null;
  let externalNativeWatchSessionId: string | null = null;
  let externalNativeWatchFingerprint: string | null = null;

  // Throttle interval for upload_progress emissions.
  const UPLOAD_PROGRESS_INTERVAL_MS = 250;

  function maybeEmitUploadProgress(uploadId: string, force = false): void {
    const upload = activeUploads.get(uploadId);
    if (!upload) return;
    const now = Date.now();
    if (!force && now - upload.lastProgressEmit < UPLOAD_PROGRESS_INTERVAL_MS) return;
    upload.lastProgressEmit = now;
    sendJson({
      type: "upload_progress",
      uploadId,
      bytesReceived: upload.bytesReceived,
      totalBytes: upload.totalBytes,
      receivedChunks: upload.receivedChunks,
      totalChunks: upload.totalChunks,
    });
  }

  function sendJson(obj: Record<string, unknown>): void {
    if (transport.readyState === WebSocket.OPEN) {
      const startedAt = Date.now();
      const raw = JSON.stringify(redactSecretsDeep(obj));
      logSlowWs("ws_send_json", startedAt, {
        type: obj.type || "unknown",
        bytes: Buffer.byteLength(raw),
      });
      transport.send(raw);
    }
  }

  // Expose raw send for broadcasting (already JSON-stringified)
  function sendRaw(data: string): void {
    if (transport.readyState === WebSocket.OPEN) {
      transport.send(data);
    }
  }

  function stopExternalNativeWatcher(): void {
    if (externalNativeWatchTimer) {
      clearInterval(externalNativeWatchTimer);
      externalNativeWatchTimer = null;
    }
    externalNativeWatchSessionId = null;
    externalNativeWatchFingerprint = null;
  }

  function closeConnection(): void {
    stopExternalNativeWatcher();
    terminalSessionManager.detach(transport);
  }

  function resolveTerminalCwd(rawCwd: unknown): string {
    const candidates = [
      typeof rawCwd === "string" && rawCwd.trim() ? rawCwd.trim() : undefined,
      activeSession?.getCwd?.(),
      activeSessionId ? getSession(activeSessionId)?.cwd : undefined,
      getDefaultCwd(),
      os.homedir(),
      process.cwd(),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      try {
        if (fs.statSync(resolved).isDirectory()) return resolved;
      } catch {
        // Try the next candidate.
      }
    }
    return process.cwd();
  }

  function emitExternalNativeHistory(sessionInfo: SessionInfo, added: any[]): void {
    if (added.length === 0) return;
    const total = getHistoryCount(sessionInfo.id);
    sendJson({
      type: "session_history",
      sessionId: sessionInfo.id,
      messages: added,
      total,
      offset: Math.max(0, total - added.length),
      append: true,
    });
    broadcastSessionList();
  }

  function scheduleCodexNativeHistorySync(sessionInfo: SessionInfo, lastTimestamp: string | undefined, reason: string): void {
    if (sessionInfo.backend !== "codex") return;
    if (!nativeHistoryChangedSince(sessionInfo, lastTimestamp)) return;
    const timer = setTimeout(() => {
      syncCodexNativeHistory(sessionInfo).then((added) => {
        if (added.length > 0) {
          emitExternalNativeHistory(sessionInfo, added);
        }
      }).catch((err) => {
        console.warn(`[CodexSync] ${reason} native history sync failed for ${sessionInfo.id}: ${err?.message || err}`);
      });
    }, 0);
    timer.unref?.();
  }

  function startExternalNativeWatcher(sessionInfo: SessionInfo): void {
    if (externalNativeWatchSessionId === sessionInfo.id && externalNativeWatchTimer) return;
    stopExternalNativeWatcher();
    externalNativeWatchSessionId = sessionInfo.id;
    externalNativeWatchFingerprint = nativeHistoryFingerprintForSession(sessionInfo);

    const tick = () => {
      if (transport.readyState !== WebSocket.OPEN) {
        stopExternalNativeWatcher();
        return;
      }
      const fingerprint = nativeHistoryFingerprintForSession(sessionInfo);
      const fileChanged = !!fingerprint && fingerprint !== externalNativeWatchFingerprint;
      if (fingerprint) externalNativeWatchFingerprint = fingerprint;
      if (!fileChanged) return;

      const added = syncExternalNativeHistory(sessionInfo);
      if (added.length > 0) {
        emitExternalNativeHistory(sessionInfo, added);
      }
      if (fileChanged || added.length > 0) {
        markExternalNativeSessionActive(sessionInfo.id);
      }
    };

    externalNativeWatchTimer = setInterval(tick, 2000);
    tick();
  }

  function codexUnavailable(): boolean {
    return !getCodexAvailability().available;
  }

  function isCodexMissingAuthReason(reason: string | undefined): boolean {
    return /auth\.json|authentication|auth/i.test(reason || "");
  }

  function sendCodexUnavailable(prefix = "Codex backend is not available on this server", sessionId?: string): void {
    const availability = getCodexAvailability();
    const detail = availability.reason || "unknown reason";
    if (isCodexMissingAuthReason(detail)) {
      markBackendAuthRequired("codex", detail);
      invalidateCodexAvailabilityCache();
      invalidateCodexDriverAvailabilityCache();
      sendJson({
        type: "backend_auth_required",
        backend: "codex",
        sessionId,
        message: "Codex authentication is missing, invalid, or expired. Sign in to Codex to continue.",
        detail,
      });
      sendJson({
        type: "server_settings",
        ...getAdvertisedServerSettings(),
        codexCollaborationMode: pendingCodexCollaborationMode,
      });
      broadcastServerCapabilities();
      return;
    }

    sendJson({
      type: "error",
      message: `${prefix}: ${detail}`,
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForFileSendBackpressure(): Promise<void> {
    const maxBufferedBytes = 512 * 1024;
    while (transport.readyState === WebSocket.OPEN) {
      const bufferedAmount = Number((transport as any).bufferedAmount || 0);
      if (!Number.isFinite(bufferedAmount) || bufferedAmount <= maxBufferedBytes) {
        return;
      }
      await sleep(25);
    }
  }

  async function sendFileChunks(filePath: string, fileId?: string, offsetBytes = 0): Promise<void> {
    if (!filePath || !fs.existsSync(filePath)) {
      sendJson({
        type: "error",
        message: `File not found: ${filePath}`,
      });
      return;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      sendJson({ type: "error", message: `Not a file: ${filePath}` });
      return;
    }
    const transferId = fileId || crypto.randomUUID();
    const fileName = path.basename(filePath);
    const transferVersion = (activeFileSendVersions.get(transferId) || 0) + 1;
    const connectionGeneration = transport.connectionGeneration;
    activeFileSendVersions.set(transferId, transferVersion);
    const isCurrentTransfer = () =>
      activeFileSendVersions.get(transferId) === transferVersion &&
      (connectionGeneration === undefined || transport.connectionGeneration === connectionGeneration);
    const CHUNK_SIZE = 96 * 1024; // Keep encrypted/base64 JSON frames modest for mobile links.
    const totalChunks = Math.ceil(stat.size / CHUNK_SIZE);
    const startOffset = Math.max(0, Math.min(Math.floor(offsetBytes || 0), stat.size));
    console.log(`Sending file in ${totalChunks} chunks: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB${startOffset > 0 ? `, resume=${startOffset}` : ""})`);

    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(CHUNK_SIZE);
      for (let position = startOffset; position < stat.size;) {
        if (transport.readyState !== WebSocket.OPEN || !isCurrentTransfer()) {
          console.warn(`File transfer aborted, socket closed: ${fileName} (id=${transferId}, offset=${position}/${stat.size})`);
          return;
        }
        await waitForFileSendBackpressure();
        if (!isCurrentTransfer()) {
          console.warn(`File transfer superseded: ${fileName} (id=${transferId}, offset=${position}/${stat.size})`);
          return;
        }
        const chunkIndex = Math.floor(position / CHUNK_SIZE);
        const bytesRead = fs.readSync(fd, buf, 0, Math.min(CHUNK_SIZE, stat.size - position), position);
        const chunk = buf.subarray(0, bytesRead).toString("base64");
        sendJson({
          type: "file_chunk",
          fileId: transferId,
          fileName,
          fileSize: stat.size,
          offsetBytes: position,
          chunkIndex,
          totalChunks,
          data: chunk,
        });
        position += bytesRead;
        await sleep(8);
      }
    } finally {
      fs.closeSync(fd);
    }

    await waitForFileSendBackpressure();
    if (transport.readyState !== WebSocket.OPEN || !isCurrentTransfer()) {
      console.warn(`File transfer completion suppressed: ${fileName} (id=${transferId})`);
      return;
    }
    sendJson({
      type: "file_complete",
      fileId: transferId,
      fileName,
      fileSize: stat.size,
    });
    if (activeFileSendVersions.get(transferId) === transferVersion) {
      activeFileSendVersions.delete(transferId);
    }
    console.log(`File transfer complete: ${fileName}`);
  }

  function resolveUploadTarget(targetDir: string, fileNameInput: string, conflictPolicy: string): string {
    const roots = getFileManagerRoots(getDefaultCwd());
    const dir = resolveFileManagerPath(targetDir, getDefaultCwd());
    assertFileManagerPathAllowed(dir, roots);
    const dirStat = fs.statSync(dir);
    if (!dirStat.isDirectory()) throw new Error(`Upload target is not a directory: ${dir}`);

    const fileName = path.basename(fileNameInput || "upload");
    if (!fileName || fileName === "." || fileName === "..") throw new Error("Invalid file name");
    let filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) return filePath;

    if (conflictPolicy === "overwrite") {
      if (fs.statSync(filePath).isDirectory()) throw new Error(`Cannot overwrite directory: ${filePath}`);
      return filePath;
    }
    if (conflictPolicy === "fail") {
      throw new Error(`File already exists: ${filePath}`);
    }

    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let counter = 1;
    while (fs.existsSync(filePath)) {
      filePath = path.join(dir, `${base} (${counter})${ext}`);
      counter++;
    }
    return filePath;
  }

  async function handleMessage(msg: ClientMessage): Promise<void> {
    // Wire-format handshake — relay path absorbs this earlier in relay-client,
    // so the only callers reaching here are direct-WS clients. Reply so the
    // app knows binary uploads are supported.
    if ((msg as any).type === "client_capabilities") {
      sendJson({
        ...serverCapabilitiesPayload(true),
        codexCollaborationMode: pendingCodexCollaborationMode,
      });
      return;
    }

    switch (msg.type) {
      case "terminal_attach": {
        terminalSessionManager.attach(transport, {
          cwd: resolveTerminalCwd((msg as any).cwd),
          cols: (msg as any).cols,
          rows: (msg as any).rows,
        });
        break;
      }

      case "terminal_input": {
        terminalSessionManager.input((msg as any).data);
        break;
      }

      case "terminal_resize": {
        terminalSessionManager.resize((msg as any).cols, (msg as any).rows);
        break;
      }

      case "terminal_detach": {
        terminalSessionManager.detach(transport);
        break;
      }

      case "terminal_kill": {
        terminalSessionManager.kill();
        break;
      }

      case "register_push_token": {
        const token = typeof msg.fcmToken === "string" ? msg.fcmToken : "";
        const appServerId = typeof msg.appServerId === "string" ? msg.appServerId : undefined;
        if (token.trim()) {
          registerPushToken(
            token,
            typeof msg.platform === "string" ? msg.platform : "android",
            appServerId,
          );
          sendJson({ type: "push_token_registered", appServerId });
        } else {
          sendJson({ type: "error", message: "Missing FCM token" });
        }
        break;
      }

      case "unregister_push_token": {
        const token = typeof (msg as any).fcmToken === "string" ? (msg as any).fcmToken : "";
        const appServerId = typeof (msg as any).appServerId === "string" ? (msg as any).appServerId : undefined;
        if (token.trim()) {
          unregisterPushToken(token, appServerId);
          sendJson({ type: "push_token_unregistered", appServerId });
        } else {
          sendJson({ type: "error", message: "Missing FCM token" });
        }
        break;
      }

      case "get_push_registration": {
        const token = typeof (msg as any).fcmToken === "string" ? (msg as any).fcmToken : "";
        const appServerId = typeof (msg as any).appServerId === "string" ? (msg as any).appServerId : undefined;
        sendJson({
          type: "push_registration_status",
          appServerId,
          registered: isPushTokenRegistered(token, appServerId),
        });
        break;
      }

      case "get_server_settings": {
        sendJson({
          type: "server_settings",
          ...getAdvertisedServerSettings(),
          codexCollaborationMode: pendingCodexCollaborationMode,
        });
        break;
      }

      case "backend_install": {
        const backend = msg.backend;
        const requestId = ((msg as any).requestId as string | undefined) || `backend_${backend}_${Date.now()}`;
        const reinstall = (msg as any).reinstall === true;
        const authenticate = (msg as any).authenticate === true;
        const operation = ((msg as any).operation === "auth" || (authenticate && !reinstall))
          ? "auth"
          : "repair";
        const backendName = backend === "codex" ? "Codex" : "Claude";
        const operationName = operation === "auth" ? "sign-in" : "repair";

        const sendProgress = (progress: Record<string, unknown>) => {
          sendJson({
            type: "backend_install_progress",
            requestId,
            backend,
            operation,
            ...progress,
          });
        };

        if (activeBackendInstalls.has(backend)) {
          const active = activeBackendInstalls.get(backend);
          sendProgress({
            phase: "install",
            status: "failed",
            message: `${backendName} backend ${active?.operation === "auth" ? "sign-in" : "repair"} is already running on this server.`,
          });
          break;
        }

        if (backend === "claude" && authenticate) {
          try {
            const authRequest = createClaudeAuthRequest();
            const timeout = setTimeout(() => {
              finishClaudeBackendAuth(requestId, {
                phase: "auth",
                status: "failed",
                message: "Claude sign-in timed out. Start Claude sign-in again if you still need it.",
              });
            }, 15 * 60 * 1000);

            activeBackendInstalls.set(backend, {
              requestId,
              operation,
              sendProgress,
            });
            pendingClaudeBackendAuth.set(requestId, {
              request: authRequest,
              sendProgress,
              timeout,
            });

            sendProgress({
              phase: "auth",
              status: "running",
              message: "Open the Claude login page, finish sign-in, then paste the copied auth code here.",
              authUrl: authRequest.authUrl,
            });
          } catch (e: any) {
            activeBackendInstalls.delete(backend);
            sendProgress({
              phase: "auth",
              status: "failed",
              message: `Claude sign-in failed to start: ${e?.message || String(e)}`,
            });
          }
          break;
        }

        const abortController = new AbortController();
        activeBackendInstalls.set(backend, {
          requestId,
          operation,
          abortController,
          sendProgress,
        });

        sendProgress({
          phase: "install",
          status: "running",
          message: `Starting ${backendName} backend ${operationName}...`,
        });
        void runBackendInstall({
          backend,
          reinstall,
          authenticate,
          signal: abortController.signal,
          onProgress: sendProgress as any,
        }).then(() => {
          if (backend === "claude") refreshClaudeExecutableInfo();
          clearBackendHealthOverride(backend);
          invalidateCodexAvailabilityCache();
          invalidateCodexDriverAvailabilityCache();
          invalidateBackendHealthCache();
          sendProgress({
            phase: "probe",
            status: "completed",
            message: `${backendName} backend ${operationName} completed.`,
          });
          broadcastServerCapabilities();
          sendJson({
            type: "server_settings",
            ...getAdvertisedServerSettings(),
            codexCollaborationMode: pendingCodexCollaborationMode,
          });
          broadcastSessionList();
        }).catch((e: any) => {
          const cancelled = abortController.signal.aborted;
          invalidateCodexAvailabilityCache();
          invalidateCodexDriverAvailabilityCache();
          invalidateBackendHealthCache();
          sendProgress({
            phase: "probe",
            status: cancelled ? "cancelled" : "failed",
            message: cancelled
              ? `${backendName} backend ${operationName} stopped.`
              : `${backendName} repair failed: ${e?.message || String(e)}`,
          });
          broadcastServerCapabilities();
        }).finally(() => {
          const active = activeBackendInstalls.get(backend);
          if (!active || active.requestId === requestId) {
            activeBackendInstalls.delete(backend);
          }
        });
        break;
      }

      case "backend_install_cancel": {
        const backend = msg.backend;
        const requestId = (msg as any).requestId as string | undefined;
        const backendName = backend === "codex" ? "Codex" : "Claude";
        const active = activeBackendInstalls.get(backend);
        const operation = active?.operation || "repair";
        const operationName = operation === "auth" ? "sign-in" : "repair";

        const sendProgress = (progress: Record<string, unknown>) => {
          sendJson({
            type: "backend_install_progress",
            requestId: active?.requestId || requestId,
            backend,
            operation,
            ...progress,
          });
        };

        if (!active || (requestId && active.requestId !== requestId)) {
          sendProgress({
            phase: operation === "auth" ? "auth" : "probe",
            status: "cancelled",
            message: `No ${backendName} backend operation is running.`,
          });
          break;
        }

        if (backend === "claude" && pendingClaudeBackendAuth.has(active.requestId)) {
          finishClaudeBackendAuth(active.requestId, {
            phase: "auth",
            status: "cancelled",
            message: "Claude sign-in stopped.",
          });
          break;
        }

        active.sendProgress?.({
          phase: operation === "auth" ? "auth" : "install",
          status: "running",
          message: `Stopping ${backendName} backend ${operationName}...`,
        });
        active.abortController?.abort();
        break;
      }

      case "get_status_sync": {
        sendStatusSyncTo(transport as WebSocket);
        break;
      }

      case "set_codex_driver": {
        sendJson({
          type: "server_settings",
          ...getAdvertisedServerSettings(),
          codexCollaborationMode: pendingCodexCollaborationMode,
        });
        break;
      }

      case "set_server_settings": {
        try {
          if (typeof (msg as any).defaultCwd === "string") {
            setDefaultCwd((msg as any).defaultCwd);
          }
          sendJson({
            type: "server_settings",
            ...getAdvertisedServerSettings(),
            codexCollaborationMode: pendingCodexCollaborationMode,
          });
        } catch (e: any) {
          sendJson({
            type: "error",
            message: `Failed to update server settings: ${e.message || String(e)}`,
          });
        }
        break;
      }

      case "codex_collaboration_modes": {
        const fallback = [{ id: "default", name: "Default" }];
        if (!(activeSession instanceof CodexSession)) {
          sendJson({
            type: "codex_collaboration_modes",
            modes: fallback,
            currentMode: pendingCodexCollaborationMode,
          });
          break;
        }
        activeSession.listCodexCollaborationModes().then((modes) => {
          sendJson({
            type: "codex_collaboration_modes",
            modes: modes.length > 0 ? modes : fallback,
            currentMode: pendingCodexCollaborationMode,
          });
        }).catch((e: any) => {
          sendJson({
            type: "codex_collaboration_modes",
            modes: fallback,
            currentMode: pendingCodexCollaborationMode,
            error: e.message || String(e),
          });
        });
        break;
      }

      case "set_codex_collaboration_mode": {
        const mode = String((msg as any).mode || "default").trim() || "default";
        pendingCodexCollaborationMode = mode;
        if (activeSession instanceof CodexSession) {
          activeSession.setCodexCollaborationMode(mode);
        }
        sendJson({
          type: "codex_collaboration_mode_changed",
          mode,
        });
        break;
      }

      case "retract_queued_prompt": {
        const messageId = msg.messageId || "";
        let retracted = false;
        if (activeSession instanceof CodexSession) {
          retracted = activeSession.retractQueuedPrompt(messageId) !== null;
        }
        sendJson({ type: "queued_prompt_retracted", messageId, retracted });
        break;
      }

      case "new_session": {
        stopExternalNativeWatcher();
        const cwd = msg.cwd || getDefaultCwd();
        if (msg.backend === "codex" && codexUnavailable()) {
          sendCodexUnavailable();
          break;
        }
        // Detach old session so it stops sending to this client
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        activeSession = createSession(msg.backend, transport as any, cwd, plugins);
        activeSessionId = null;
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setTtsEngine(pendingTtsEngine);
        activeSession.setKokoroVoice(pendingKokoroVoice);
        activeSession.setKokoroSpeed(pendingKokoroSpeed);
        activeSession.setEffort(pendingEffort as any);
        activeSession.setThinking(pendingThinking);
        activeSession.setDisallowedTools(pendingDisallowedTools);
        activeSession.setAppendSystemPrompt(pendingSystemPrompt);
        (activeSession as any).setCodexCollaborationMode?.(pendingCodexCollaborationMode);
        (activeSession as any).setCodexFastMode?.(pendingCodexFastMode);
        (activeSession as any).setClaudeAutoCompact?.(pendingClaudeAutoCompact);

        addRecentCwd(cwd);
        sendJson({
          type: "session_created",
          sessionId: "",
          cwd,
          title: "Untitled",
        });
        break;
      }

      case "resume_session": {
        // Detach old session so it stops sending to this client
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        const resumeCwd = (msg as any).cwd || getDefaultCwd();
        let sessionInfo = getSession(msg.sessionId);
        // If not in SocketAgent store but cwd is provided, this is an SDK-only
        // session (claude or codex). The caller passes `backend` so we tag the
        // freshly-registered SessionInfo correctly — without it, codex SDK
        // resumes would default to claude and fail on the first prompt.
        if (!sessionInfo && (msg as any).cwd) {
          const sdkBackend = ((msg as any).backend as "claude" | "codex" | undefined);
          sessionInfo = {
            id: msg.sessionId,
            title: "Untitled",
            cwd: resumeCwd,
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            messagePreview: "",
            backend: sdkBackend,
            ...(sdkBackend === "codex" ? { codexDriver: "app-server" as CodexDriver } : {}),
          };
          saveSession(sessionInfo);
          console.log(`[Resume] Created SocketAgent entry for SDK session ${msg.sessionId} in ${resumeCwd} (backend=${sdkBackend ?? "claude"})`);
        }
        if (!sessionInfo) {
          const nativeCodex = await getCodexNativeThreadSessionInfo(
            msg.sessionId,
            resumeCwd,
          );
          if (nativeCodex) {
            sessionInfo = nativeCodex;
            saveSession(sessionInfo);
            console.log(`[Resume] Created SocketAgent entry for native Codex thread ${msg.sessionId} in ${nativeCodex.cwd}`);
          }
        }
        if (!sessionInfo && isCodexThreadArchived(msg.sessionId)) {
          deleteSession(msg.sessionId);
          invalidateCodexNativeListCache();
          sendJson({ type: "session_archived", sessionId: msg.sessionId });
          broadcastSessionList();
          break;
        }
        if (!sessionInfo) {
          sendJson({
            type: "error",
            message: `Session ${msg.sessionId} not found`,
          });
          break;
        }
        const contextCleared = isContextClearedSession(sessionInfo, msg.sessionId);
        if (!contextCleared && sessionInfo.backend === "codex" && getStoredCodexDriver(sessionInfo) === "app-server" && isCodexThreadArchived(msg.sessionId)) {
          const running = activeSessions.get(msg.sessionId);
          if (running) {
            running.abort();
            activeSessions.delete(msg.sessionId);
          }
          deleteSession(msg.sessionId);
          invalidateCodexNativeListCache();
          console.log(`[Resume] Refusing to resume archived native Codex thread ${msg.sessionId}`);
          sendJson({ type: "session_archived", sessionId: msg.sessionId });
          broadcastSessionList();
          break;
        }
        if (sessionInfo.backend === "codex" && codexUnavailable()) {
          sendCodexUnavailable("This is a Codex session, but Codex is not available on this server", msg.sessionId);
          break;
        }

        // Check if this session is still running in the background
        const existing = activeSessions.get(msg.sessionId);
        if (existing) {
          // Reattach the transport to the running session
          existing.setWebSocket(transport as any);
          activeSession = existing;
          console.log(`Reconnected to running session ${msg.sessionId}`);
        } else {
          activeSession = createSession(sessionInfo.backend, transport as any, sessionInfo.cwd, plugins, getStoredCodexDriver(sessionInfo));
          await restorePersistedPermissionMode(activeSession, sessionInfo);
          (activeSession as any)._resumeSessionId = msg.sessionId;
        }
        activeSessionId = msg.sessionId;
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setTtsEngine(pendingTtsEngine);
        activeSession.setKokoroVoice(pendingKokoroVoice);
        activeSession.setKokoroSpeed(pendingKokoroSpeed);
        activeSession.setEffort(pendingEffort as any);
        activeSession.setThinking(pendingThinking);
        activeSession.setDisallowedTools(pendingDisallowedTools);
        activeSession.setAppendSystemPrompt(pendingSystemPrompt);
        (activeSession as any).setCodexCollaborationMode?.(pendingCodexCollaborationMode);
        (activeSession as any).setCodexFastMode?.(pendingCodexFastMode);
        (activeSession as any).setClaudeAutoCompact?.(pendingClaudeAutoCompact);


        // Register this client so /continue can find the real WebSocket
        sessionClients.set(msg.sessionId, {
          ws: transport as WebSocket,
          setActiveSession: (s: Session) => { activeSession = s; },
        });

        sendJson({
          type: "session_created",
          sessionId: msg.sessionId,
          cwd: sessionInfo.cwd,
          title: sessionInfo.title,
          ...(activeSession.permissionMode ? { permissionMode: activeSession.permissionMode } : {}),
        });

        // Send message history — if session is running, load back to last user prompt
        const historyStartMs = Date.now();
        const isRunning = activeSessions.has(msg.sessionId) && activeSessions.get(msg.sessionId)!.isRunning;
        if (sessionInfo.backend === "codex" && !contextCleared && getHistoryCount(msg.sessionId) === 0) {
          syncCodexRolloutHistory(sessionInfo);
        }
        const page = isRunning
          ? getHistoryPageToLastPrompt(msg.sessionId, 50)
          : getHistoryPage(msg.sessionId, 50);
        const todos = getTodos(msg.sessionId);
        const lastSuggestion = getLastPromptSuggestion(msg.sessionId);
        sendJson({
          type: "session_history",
          sessionId: msg.sessionId,
          messages: page.entries,
          total: page.total,
          offset: page.offset,
          ...(todos.length > 0 ? { todos } : {}),
          ...(lastSuggestion ? { promptSuggestion: lastSuggestion } : {}),
        });
        console.log(`[ResumeHistory] sent initial history for ${msg.sessionId}: entries=${page.entries.length} total=${page.total} offset=${page.offset} ms=${Date.now() - historyStartMs}`);

        // Check for missed messages from Claude Code's session file
        const lastTimestamp = getLastHistoryTimestamp(msg.sessionId);
        if (sessionInfo.backend === "codex" && !contextCleared) {
          scheduleCodexNativeHistorySync(sessionInfo, lastTimestamp, "resume");
        } else if (sessionInfo.backend === "codex" && contextCleared) {
          console.log(`[Resume] Skipping Codex native history sync for cleared session ${msg.sessionId}`);
        } else {
          // When history is empty, use epoch so we sync ALL messages from the JSONL
          const missed = getMissedMessages(msg.sessionId, sessionInfo.cwd, lastTimestamp || "1970-01-01T00:00:00Z");
          if (missed.length > 0) {
            console.log(`[Resume] Found ${missed.length} missed messages from JSONL`);
            appendHistoryBulk(msg.sessionId, missed);
            sendJson({
              type: "session_history",
              sessionId: msg.sessionId,
              messages: missed,
              total: (page.total || 0) + missed.length,
              offset: page.total || 0,
              append: true,
            });
          }
        }

        if (!contextCleared && !activeSessions.has(msg.sessionId)) {
          startExternalNativeWatcher(sessionInfo);
        } else {
          stopExternalNativeWatcher();
        }

        // Restore last usage data if available
        if ((sessionInfo as any).lastUsage) {
          sendJson({
            type: "usage_restore",
            usage: (sessionInfo as any).lastUsage,
          });
        }

        // Restore last context usage breakdown (persisted between sessions).
        // If there's a live query below, it'll overwrite this with fresh data.
        if ((sessionInfo as any).lastContextUsage) {
          sendJson({
            type: "context_usage",
            sessionId: msg.sessionId,
            ...(sessionInfo as any).lastContextUsage,
          });
        }

        // Always send status so the app resets its processing state on resume
        const resumeRunning = !!(existing && existing.isRunning);
        const resumeCompacting = !!(existing && existing.isCompacting);
        const resumePermMode = activeSession.permissionMode || null;
        const activeToolInfo = existing?.getActiveToolCall?.() || null;
        const resumeActiveStartedAt = existing ? getSessionActiveStartedAt(existing) : undefined;
        console.log(`[Resume] sessionId=${msg.sessionId} existing=${!!existing} isRunning=${existing?.isRunning} compacting=${resumeCompacting} permMode=${resumePermMode} → sending running=${resumeRunning} activeToolUseId=${activeToolInfo?.toolUseId || 'none'} activeStartedAt=${resumeActiveStartedAt || 'none'}`);
        sendJson({
          type: "status",
          sessionId: msg.sessionId,
          running: resumeRunning || resumeCompacting,
          compacting: resumeCompacting,
          ...(resumeActiveStartedAt ? { activeStartedAt: resumeActiveStartedAt } : {}),
          ...(activeToolInfo ? { activeToolUseId: activeToolInfo.toolUseId } : {}),
          ...(resumePermMode ? { permissionMode: resumePermMode } : {}),
        });

        // Send detailed context usage on resume (if session has an active query)
        if (existing) {
          (existing as any).activeQuery?.getContextUsage().then((ctx: any) => {
            if (ctx) {
              sendJson({ type: "context_usage", sessionId: msg.sessionId, ...ctx });
            }
          }).catch(() => {});
        }

        // Re-send live assistant/thinking text after session_history. The app
        // replaces visible chat state on history load, so replaying earlier
        // can make the already-streamed prefix disappear for late joiners.
        if (resumeRunning && existing) {
          existing.replayLiveState?.(transport as any);
        }

        // Re-send accumulated bash output so the reconnecting client sees live output
        if (resumeRunning && existing) {
          const bashOutput = existing.getAccumulatedBashOutput();
          if (bashOutput) {
            console.log(`[Resume] Re-sending ${bashOutput.length} chars of accumulated bash output`);
            sendJson({
              type: "tool_stderr",
              content: bashOutput,
              sessionId: msg.sessionId,
            });
          }
        }

        break;
      }

      case "prompt": {
        const promptCodexFastMode = typeof (msg as any).codexFastMode === "boolean"
          ? Boolean((msg as any).codexFastMode)
          : undefined;
        if (msg.sessionId) {
          const runningForPrompt = activeSessions.get(msg.sessionId);
          if (runningForPrompt && activeSession !== runningForPrompt) {
            runningForPrompt.setWebSocket(transport as any);
            activeSession = runningForPrompt;
            activeSessionId = msg.sessionId;
            sessionClients.set(msg.sessionId, {
              ws: transport as WebSocket,
              setActiveSession: (s: Session) => { activeSession = s; },
            });
            console.log(`[Prompt] Reattached to running session ${msg.sessionId} before injection`);
          }
        }

        if (!activeSession) {
          let cwd = getDefaultCwd();
          const savedResumeId = msg.sessionId;
          if (savedResumeId) {
            const savedSession = getSession(savedResumeId);
            if (savedSession) {
              cwd = savedSession.cwd;
            }
          } else if (msg.cwd) {
            cwd = msg.cwd;
            addRecentCwd(cwd);
          }
          const savedPromptSession = savedResumeId ? getSession(savedResumeId) : undefined;
          const promptBackend = savedPromptSession?.backend;
          if (promptBackend === "codex" && codexUnavailable()) {
            sendCodexUnavailable("This is a Codex session, but Codex is not available on this server", savedResumeId);
            break;
          }
          activeSession = createSession(promptBackend, transport as any, cwd, plugins, getStoredCodexDriver(savedPromptSession));
          await restorePersistedPermissionMode(activeSession, savedPromptSession);
          activeSessionId = savedResumeId || null;
          activeSession.setTtsEnabled(pendingTtsEnabled);
          activeSession.setTtsEngine(pendingTtsEngine);
          activeSession.setKokoroVoice(pendingKokoroVoice);
          activeSession.setKokoroSpeed(pendingKokoroSpeed);
          activeSession.setEffort(pendingEffort as any);
          activeSession.setThinking(pendingThinking);
          activeSession.setDisallowedTools(pendingDisallowedTools);
          activeSession.setAppendSystemPrompt(pendingSystemPrompt);
          (activeSession as any).setCodexCollaborationMode?.(pendingCodexCollaborationMode);
          (activeSession as any).setCodexFastMode?.(pendingCodexFastMode);
          (activeSession as any).setClaudeAutoCompact?.(pendingClaudeAutoCompact);
        }

        // If session is already running, inject the message inline between turns
        if (activeSession.isRunning) {
          const priority = (msg as any).priority || 'now';
          const messageId = (msg as any).messageId || '';
          console.log(`[Inject] Session running, injecting user message inline (priority=${priority}, messageId=${messageId})`);
          const injectOptions = activeSession instanceof CodexSession
            ? { fastMode: promptCodexFastMode ?? pendingCodexFastMode }
            : undefined;
          (activeSession as any).injectMessage(msg.text, priority, messageId, injectOptions).then(() => {
            // Acknowledge injection so the app can promote the pending message
            sendJson({ type: "injection_ack", messageId });
          }).catch((e: any) => {
            if (e?.message === "Queued prompt retracted") {
              console.log(`[Inject] Queued prompt retracted (messageId=${messageId})`);
            } else {
              console.error(`[Inject] Failed: ${e}`);
              sendJson({
                type: "injection_failed",
                messageId,
                message: e?.message || String(e),
              } as any);
            }
          });
          break;
        }

        let resumeId: string | undefined =
          msg.sessionId ||
          (activeSession as any)._resumeSessionId ||
          activeSession.getSessionId() ||
          undefined;

        // If context was cleared, don't resume — start fresh. The in-memory
        // set covers the current process; contextClearedAt covers restarts
        // between the clear and the user's next prompt.
        const resumeSessionInfo = resumeId ? getSession(resumeId) : undefined;
        if (resumeId && isContextClearedSession(resumeSessionInfo, resumeId)) {
          console.log(`[Clear] Session ${resumeId} was cleared, starting fresh (no resume)`);
          clearedSessions.delete(resumeId);
          activeSession.replacesSessionId = resumeId;
          resumeId = undefined;
        }

        if (resumeId) {
          if (resumeSessionInfo?.backend === "codex") {
            scheduleCodexNativeHistorySync(resumeSessionInfo, getLastHistoryTimestamp(resumeId), "prompt");
          }
        }

        (activeSession as any)._resumeSessionId = undefined;

        attachSessionLifecycleCallbacks(activeSession);
        if (resumeId) {
          activeSessions.set(resumeId, activeSession);
          activeSessionId = resumeId;
          sessionClients.set(resumeId, {
            ws: transport as WebSocket,
            setActiveSession: (s: Session) => { activeSession = s; },
          });
        }

        // Set up monitor output callback — starts a new query when session is idle
        activeSession.onMonitorOutput = (text: string) => {
          if (!activeSession) return;
          if (activeSession.isRunning) {
            // Race: session started running between debounce and callback
            activeSession.injectMessage(text, 'next').catch(e => console.error(`[Monitor] Inject race: ${e}`));
            return;
          }
          const monitorSid = activeSession.getSessionId() || undefined;
          console.log(`[Monitor] Starting query for idle session ${monitorSid}`);
          attachSessionLifecycleCallbacks(activeSession);
          activeSession.runQuery(text, monitorSid).then(() => {
            const s = activeSession?.getSessionId();
            if (s && activeSessions.get(s) === activeSession && !sessionShouldRemainPooled(activeSession)) {
              activeSessions.delete(s);
            }
            broadcastSessionList();
          }).catch((err) => {
            console.error(`[Monitor] Query error: ${err.message || err}`);
          });
        };

        const sessionForRun = activeSession;
        const runOptions = sessionForRun instanceof CodexSession
          ? {
              fastMode: promptCodexFastMode ?? pendingCodexFastMode,
              messageId: (msg as any).messageId || undefined,
            }
          : undefined;
        const runPromise = (sessionForRun as any).runQueryWithOptions
          ? (sessionForRun as any).runQueryWithOptions(msg.text, resumeId, runOptions)
          : sessionForRun.runQuery(msg.text, resumeId);
        let sessionStartedPushSent = false;
        const maybeSendSessionStartedPush = () => {
          if (sessionStartedPushSent) return;
          sessionStartedPushSent = sendSessionStartedPush(sessionForRun);
        };
        maybeSendSessionStartedPush();
        runPromise.then(() => {
          const sid = sessionForRun.getSessionId();
          if (sid && activeSessions.get(sid) === sessionForRun) {
            // Keep session in pool if auth login is pending
            if (sessionShouldRemainPooled(sessionForRun)) {
              console.log(`Session ${sid} query completed but remains pooled`);
            } else {
              activeSessions.delete(sid);
              console.log(`Session ${sid} completed, removed from active pool`);
            }
          }
          sendSessionCompletionPush(sessionForRun, "completed");
          broadcastSessionList();
        }).catch((err: any) => {
          const sid = sessionForRun.getSessionId();
          if (sid && activeSessions.get(sid) === sessionForRun && !sessionShouldRemainPooled(sessionForRun)) {
            activeSessions.delete(sid);
          }
          if (sessionForRun instanceof CodexSession && isCodexAuthError(err)) {
            const detail = err?.message || String(err);
            markBackendAuthRequired("codex", detail);
            invalidateCodexAvailabilityCache();
            invalidateCodexDriverAvailabilityCache();
            sendJson({
              type: "backend_auth_required",
              backend: "codex",
              sessionId: sid,
              message: "Codex authentication is invalid or expired. Sign in to Codex again to continue.",
              detail,
            });
            sendJson({
              type: "server_settings",
              ...getAdvertisedServerSettings(),
              codexCollaborationMode: pendingCodexCollaborationMode,
            });
            broadcastServerCapabilities();
            sendSessionCompletionPush(sessionForRun, "failed", "Codex sign-in required");
          } else {
            sendJson({
              type: "error",
              message: err.message || "Query failed",
            });
            sendSessionCompletionPush(sessionForRun, "failed", err.message || "Query failed");
          }
          broadcastSessionList();
        });

        // Register the session globally once it has an ID
        const checkAndRegister = () => {
          const sid = sessionForRun.getSessionId();
          if (sid && !activeSessions.has(sid)) {
            activeSessions.set(sid, sessionForRun);
          }
          if (sid) {
            maybeSendSessionStartedPush();
            activeSessionId = sid;
            sessionClients.set(sid, {
              ws: transport as WebSocket,
              setActiveSession: (s: Session) => { activeSession = s; },
            });
          }
        };
        const interval = setInterval(() => {
          checkAndRegister();
          const sid = activeSession?.getSessionId();
          if (sid) {
            clearInterval(interval);
            broadcastSessionList();
          }
        }, 500);
        setTimeout(() => clearInterval(interval), 30000);
        break;
      }

      case "answer": {
        const qId = msg.questionId as string;
        let answerHandled = false;
        const requestedSessionId =
          typeof (msg as any).sessionId === "string" && (msg as any).sessionId.trim()
            ? (msg as any).sessionId.trim()
            : undefined;
        const activeSid = activeSession?.getSessionId()
          || (activeSession as any)?._resumeSessionId
          || activeSessionId
          || undefined;
        const answerSession = requestedSessionId
          ? activeSessions.get(requestedSessionId)
            || (activeSid === requestedSessionId ? activeSession : undefined)
          : activeSession;
        const answerSid = answerSession?.getSessionId()
          || (answerSession as any)?._resumeSessionId
          || requestedSessionId
          || activeSid
          || undefined;
        // Get session context if available, or build a minimal one for plugin-only answers
        const sessionCtx = answerSession
          ? answerSession.getSessionContext()
          : {
              sessionId: answerSid || "",
              cwd: getDefaultCwd(),
              send: (m: any) => sendJson(m),
              appendHistory: () => {},
              pendingQuestions: new Map(),
              questionCounter: { next: () => "" },
            };
        for (const plugin of plugins) {
          if (plugin.answerMiddleware) {
            const result = await plugin.answerMiddleware(qId, msg.answers, sessionCtx);
            if (result.handled) {
              answerHandled = true;
              sendJson({ type: "question_answered", questionId: qId });
              if (answerSid) markQuestionAnswered(answerSid, qId);
              break;
            }
          }
        }
        if (!answerHandled && answerSession) {
          const resolved = answerSession.resolveQuestion(qId, msg.answers);
          if (!resolved) {
            // Question promise is gone (e.g. after server restart) — inject as prompt
            const answers = msg.answers as Record<string, string>;
            const parts: string[] = [];
            for (const [question, answer] of Object.entries(answers)) {
              parts.push(`Q: ${question}\nA: ${answer}`);
            }
            const injectedText = `[You previously asked me a question. Here is my answer:]\n\n${parts.join("\n\n")}`;
            console.log(`[Answer] No pending promise for ${qId}, injecting as prompt`);
            // Confirm to app that the question was handled (so card marks as answered)
            sendJson({ type: "question_answered", questionId: qId });
            // Resolve the session ID — check all sources (same as prompt handler)
            const sid = answerSid;
            // Mark as answered in history even though promise is gone
            if (sid) {
              markQuestionAnswered(sid, qId);
            }
            // If a query is running, inject mid-conversation; otherwise resume with answer
            if (answerSession.isRunning) {
              answerSession.injectMessage(injectedText);
            } else {
              // Resume the existing session with the answer context
              attachSessionLifecycleCallbacks(answerSession);
              answerSession.runQuery(injectedText, sid).then(() => {
                const s = answerSession?.getSessionId();
                if (s && activeSessions.get(s) === answerSession && !sessionShouldRemainPooled(answerSession)) {
                  activeSessions.delete(s);
                }
                broadcastSessionList();
              }).catch((err) => {
                sendJson({ type: "error", message: err.message || "Query failed" });
              });
            }
          }
        }
        break;
      }

      case "list_sessions": {
        sendJson({
          type: "session_list",
          sessions: await getEnrichedSessions(),
        });
        break;
      }

      case "get_recent_cwds": {
        sendJson({ type: "recent_cwds", cwds: getRecentCwds() });
        break;
      }

      case "add_recent_cwd": {
        const cwd = (msg as any).cwd as string;
        if (cwd) {
          const cwds = addRecentCwd(cwd);
          sendJson({ type: "recent_cwds", cwds });
        }
        break;
      }

      case "remove_recent_cwd": {
        const cwd = (msg as any).cwd as string;
        if (cwd) {
          const cwds = removeRecentCwd(cwd);
          sendJson({ type: "recent_cwds", cwds });
        }
        break;
      }

      case "list_sdk_sessions": {
        const cwd = (msg as any).cwd as string;
        console.log(`[SdkSessions] Request for cwd=${cwd}`);
        if (!cwd) {
          sendJson({ type: "error", message: "No cwd provided for list_sdk_sessions" });
          break;
        }
        const claudeSessions = await listSdkSessions(cwd);
        let codexSessions;
        try {
          codexSessions = await listCodexNativeSdkSessions(cwd);
        } catch (err: any) {
          console.warn(`[SdkSessions] Codex native thread/list failed for ${cwd}: ${err?.message || err}`);
          codexSessions = listCodexSessions(cwd);
        }
        // Merge and sort by lastActive desc so the most recent is on top
        // regardless of which backend produced it.
        const sessions = [...claudeSessions, ...codexSessions].sort((a, b) =>
          new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
        );
        console.log(`[SdkSessions] Found ${claudeSessions.length} claude + ${codexSessions.length} codex sessions for ${cwd}`);
        sendJson({ type: "sdk_session_list", cwd, sessions });
        break;
      }

      case "delete_session": {
        const sid = msg.sessionId;
        const running = activeSessions.get(sid);
        if (running) {
          running.abort();
          activeSessions.delete(sid);
        }
        try {
          const sessionInfo = getSession(sid) || await getCodexNativeThreadSessionInfo(sid, getDefaultCwd()) || undefined;
          const result = deleteSessionArtifacts(sid, sessionInfo);
          invalidateCodexNativeListCache();
          for (const warning of result.warnings) {
            console.warn(`[DeleteSession] ${warning}`);
          }
          console.log(`Deleted session ${sid} (${result.removed.length} artifact(s) removed)`);
          sendJson({ type: "session_deleted", sessionId: sid });
        } catch (err: any) {
          const message = err?.message || String(err);
          console.warn(`[DeleteSession] Failed to delete ${sid}: ${message}`);
          sendJson({ type: "session_delete_failed", sessionId: sid, error: message });
        }
        broadcastSessionList();
        break;
      }

      case "rename_session": {
        let session = getSession(msg.sessionId);
        if (!session) {
          const nativeCodex = await getCodexNativeThreadSessionInfo(msg.sessionId, getDefaultCwd());
          if (nativeCodex) {
            session = nativeCodex;
            saveSession(session);
          }
        }
        if (session) {
          session.title = msg.title;
          saveSession(session);
          if (session.backend === "codex" && getStoredCodexDriver(session) === "app-server") {
            renameCodexNativeThread(msg.sessionId, session.cwd, msg.title).catch((err) => {
              console.warn(`[Rename] Codex native thread/name/set failed for ${msg.sessionId}: ${err.message || err}`);
            });
          }
          console.log(`Renamed session ${msg.sessionId} to "${msg.title}"`);
          broadcastSessionList();
        }
        break;
      }

      // ── Scheduled tasks ──

      case "schedule_task": {
        const recurrence = (msg as any).recurrence;
        const backend = ((msg as any).backend === "codex" ? "codex" : "claude") as Backend;
        const codexDriver: CodexDriver | undefined = backend === "codex" ? "app-server" : undefined;
        const task: ScheduledTask = {
          id: crypto.randomUUID(),
          prompt: (msg as any).prompt,
          cwd: (msg as any).cwd,
          backend,
          ...(codexDriver ? { codexDriver } : {}),
          scheduledTime: (msg as any).scheduledTime,
          createdAt: new Date().toISOString(),
          status: "pending",
          createdBySessionId: activeSessionId || undefined,
          recurrence: recurrence && recurrence.type !== "once" ? recurrence : undefined,
          reuseSession: (msg as any).reuseSession || false,
          notificationMode: (msg as any).notificationMode === "quiet" ? "quiet" : "completion",
          runCount: 0,
          runs: [],
        };
        saveScheduledTask(task);
        console.log(`[Scheduler] Task created: ${task.id} for ${task.scheduledTime}${task.recurrence ? ` (recurring: ${task.recurrence.type})` : ""}`);
        broadcastScheduledTaskList();
        break;
      }

      case "list_scheduled_tasks": {
        sendJson({ type: "scheduled_task_list", tasks: listScheduledTasks() });
        break;
      }

      case "cancel_scheduled_task": {
        const task = getScheduledTask((msg as any).taskId);
        if (task && task.status === "pending") {
          task.status = "cancelled";
          saveScheduledTask(task);
          console.log(`[Scheduler] Task cancelled: ${task.id}`);
          broadcastScheduledTaskList();
        }
        break;
      }

      case "execute_scheduled_task": {
        const task = getScheduledTask((msg as any).taskId);
        if (!task) {
          sendJson({ type: "error", message: "Scheduled task not found" });
          break;
        }
        if (task.status === "running") {
          sendJson({ type: "error", message: "Scheduled task is already running" });
          break;
        }
        executeScheduledTask(task, "manual").catch((err: any) => {
          console.error(`[Scheduler] Manual task ${task.id} failed before launch: ${err?.message || err}`);
        });
        break;
      }

      case "update_scheduled_task": {
        const task = getScheduledTask((msg as any).taskId);
        if (task && (task.status === "pending" || task.status === "cancelled" || task.status === "running")) {
          if ((msg as any).prompt !== undefined) task.prompt = (msg as any).prompt;
          if ((msg as any).cwd !== undefined) task.cwd = (msg as any).cwd;
          if ((msg as any).backend !== undefined) {
            const nextBackend = (msg as any).backend === "codex" ? "codex" : "claude";
            if (task.backend && task.backend !== nextBackend) {
              task.sessionId = undefined;
            }
            task.backend = nextBackend;
            task.codexDriver = nextBackend === "codex" ? "app-server" : undefined;
          }
          if ((msg as any).codexDriver !== undefined) {
            task.codexDriver = task.backend === "codex" ? "app-server" : undefined;
          }
          if ((msg as any).scheduledTime !== undefined) task.scheduledTime = (msg as any).scheduledTime;
          if ((msg as any).recurrence !== undefined) {
            const rec = (msg as any).recurrence;
            task.recurrence = rec && rec.type !== "once" ? rec : undefined;
          }
          if ((msg as any).reuseSession !== undefined) task.reuseSession = (msg as any).reuseSession;
          if ((msg as any).notificationMode !== undefined) {
            task.notificationMode = (msg as any).notificationMode === "quiet" ? "quiet" : "completion";
          }
          // Allow re-activating a cancelled task
          if (task.status === "cancelled") task.status = "pending";
          saveScheduledTask(task);
          console.log(`[Scheduler] Task updated: ${task.id}`);
          broadcastScheduledTaskList();
        }
        break;
      }

      case "delete_scheduled_task": {
        deleteScheduledTask((msg as any).taskId);
        console.log(`[Scheduler] Task deleted: ${(msg as any).taskId}`);
        broadcastScheduledTaskList();
        break;
      }

      case "version_check": {
        const { execSync, exec: execCb } = require("child_process");
        const info: any = {
          type: "version_info",
          gitAvailable: !!GIT_ROOT,
          autoUpdateError: lastAutoUpdateError,
          running: {
            hash: SERVER_GIT_HASH || undefined,
            startedAt: SERVER_STARTED_AT,
            pid: process.pid,
          },
        };
        const localAppVersion = readLocalAppVersionInfo();
        if (localAppVersion) attachAppVersionInfo(info, localAppVersion);
        if (GIT_ROOT) {
          try {
            const localHash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            const localMsg = execSync("git log -1 --format=%s", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            const localDate = execSync("git log -1 --format=%ci", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            info.local = { hash: localHash, branch, message: localMsg, date: localDate };
            if (
              SERVER_GIT_HASH &&
              localHash &&
              !localHash.startsWith(SERVER_GIT_HASH) &&
              !SERVER_GIT_HASH.startsWith(localHash)
            ) {
              info.needsRestart = true;
            }

            // Fetch remote async to avoid blocking event loop (relay ping/pong)
            execCb("git fetch origin", { cwd: GIT_ROOT, timeout: 15000 }, (err: any) => {
              try {
                if (!err) {
                  const remoteHash = execSync(`git rev-parse origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
                  const remoteMsg = execSync(`git log origin/${branch} -1 --format=%s`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
                  const remoteDate = execSync(`git log origin/${branch} -1 --format=%ci`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
                  const commitsBehind = parseInt(execSync(`git rev-list --count HEAD..origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim(), 10);
                  info.remote = { hash: remoteHash, message: remoteMsg, date: remoteDate };
                  info.updateAvailable = localHash !== remoteHash;
                  info.commitsBehind = commitsBehind;
                  const remoteAppVersion = readRemoteAppVersionInfo(branch);
                  if (remoteAppVersion) attachAppVersionInfo(info, remoteAppVersion);
                } else {
                  info.fetchError = err.message;
                }
              } catch (e: any) {
                info.fetchError = e.message;
              }
              sendJson(info);
            });
          } catch (e: any) {
            info.error = e.message;
            sendJson(info);
          }
        } else {
          sendJson(info);
        }
        break;
      }

      case "force_update": {
        const { execSync } = require("child_process");
        try {
          if (process.platform === "win32") {
            let hash = "";
            try {
              hash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
            } catch {}
            try {
              armRestartRecoveryGuard("force-update", 300);
            } catch (guardErr: any) {
              sendJson({ type: "update_result", success: false, error: `Recovery guard could not be armed: ${guardErr?.message || String(guardErr)}` });
              break;
            }
            sendJson({
              type: "update_result",
              success: true,
              message: "Restarting Windows service wrapper to apply updates",
              hash,
              needsRestart: true,
            });
            setTimeout(() => {
              console.log("[ForceUpdate] Restarting Windows server so service wrapper can apply updates");
              process.exit(1);
            }, 1000);
            break;
          }

          const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
          const beforeHash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();

          // Hard reset to origin — remote servers are deployment mirrors, not dev environments
          execSync("git fetch origin", { cwd: GIT_ROOT, stdio: "pipe", timeout: 30000 });
          execSync(`git reset --hard origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" });
          const afterHash = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();

          // Always install deps + compile — source/deps may have changed
          const tscDir = fs.existsSync(path.join(GIT_ROOT, "server", "tsconfig.json"))
            ? path.join(GIT_ROOT, "server")
            : GIT_ROOT;
          runPackageUpdateSync(tscDir);
          installSocketAgentCliFromRepo(GIT_ROOT);

          if (beforeHash === afterHash) {
            if ((msg as any).forceRestart) {
              try {
                armRestartRecoveryGuard("force-update", 180);
              } catch (guardErr: any) {
                sendJson({ type: "update_result", success: false, error: `Recovery guard could not be armed: ${guardErr?.message || String(guardErr)}` });
                break;
              }
              sendJson({ type: "update_result", success: true, message: "Recompiled and restarting", hash: afterHash, needsRestart: true });
              setTimeout(() => {
                console.log(`[ForceUpdate] Force restart after recompile`);
                process.exit(1);
              }, 1000);
              break;
            }
            sendJson({ type: "update_result", success: true, message: "Already up to date (recompiled)", hash: afterHash });
            break;
          }

          const afterMsg = execSync("git log -1 --format=%s", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
          try {
            armRestartRecoveryGuard("force-update", 180);
          } catch (guardErr: any) {
            sendJson({ type: "update_result", success: false, error: `Recovery guard could not be armed: ${guardErr?.message || String(guardErr)}` });
            break;
          }
          sendJson({ type: "update_result", success: true, message: `Updated to ${afterHash.substring(0, 7)}: ${afterMsg}`, hash: afterHash, needsRestart: true });

          // Auto-restart after a short delay so the response gets sent
          setTimeout(() => {
            console.log(`[ForceUpdate] Restarting after update ${beforeHash.substring(0, 7)} → ${afterHash.substring(0, 7)}`);
            process.exit(1);
          }, 1000);
        } catch (e: any) {
          sendJson({ type: "update_result", success: false, error: e.message });
        }
        break;
      }

      case "clear_context": {
        const sid = msg.sessionId;
        const sessionInfo = getSession(sid);
        if (sessionInfo) {
          const running = activeSessions.get(sid);
          if (running) {
            running.abort();
            activeSessions.delete(sid);
          }
          if (sessionInfo.backend === "codex") {
            let archivedByAppServer = false;
            await archiveCodexAppServerThread(sid, sessionInfo.cwd)
              .then(() => { archivedByAppServer = true; })
              .catch((err) => {
                console.warn(`[ClearContext] Codex app-server thread/archive failed for ${sid}: ${err.message || err}`);
              });
            if (archivedByAppServer) {
              invalidateCodexNativeListCache();
            }
            if (archivedByAppServer && !(sessionInfo as any).codexDriver) {
              (sessionInfo as any).codexDriver = "app-server";
              saveSession(sessionInfo);
            }
          }
          clearSessionContext(sid, sessionInfo.cwd);
          clearedSessions.add(sid);
          console.log(`Cleared context for session ${sid}`);
          sendJson({ type: "context_cleared", sessionId: sid });
          broadcastSessionList();
        }
        break;
      }

      case "compact_context": {
        const targetSid = (msg as any).sessionId || activeSession?.getSessionId() || activeSessionId;
        const targetSession = targetSid
          ? activeSessions.get(targetSid) || (activeSession?.getSessionId() === targetSid ? activeSession : null)
          : activeSession;
        if (!targetSession) {
          const sessionInfo = targetSid ? getSession(targetSid) : undefined;
          if (sessionInfo?.backend === "codex") {
            compactCodexAppServerThread(targetSid, sessionInfo.cwd).then(() => {
              sendJson({ type: "codex_compact_result", sessionId: targetSid, success: true });
            }).catch((e: any) => {
              sendJson({ type: "codex_compact_result", sessionId: targetSid, success: false, error: e.message || String(e) });
              sendJson({ type: "error", message: `Codex compact failed: ${e.message || String(e)}` });
            });
            break;
          }
          sendJson({ type: "error", message: "No active session to compact" });
          break;
        }
        if (targetSession instanceof CodexSession) {
          targetSession.compactAppServerThread(targetSid || undefined).then(() => {
            sendJson({ type: "codex_compact_result", sessionId: targetSid || "", success: true });
          }).catch((e: any) => {
            sendJson({ type: "codex_compact_result", sessionId: targetSid || "", success: false, error: e.message || String(e) });
            sendJson({ type: "error", message: `Codex compact failed: ${e.message || String(e)}` });
          });
          break;
        }
        sendJson({ type: "error", message: "Manual compact is not supported for this backend through SocketAgent yet" });
        break;
      }

      case "codex_rollback_thread": {
        const targetSid = (msg as any).sessionId || activeSession?.getSessionId() || activeSessionId;
        const numTurns = Math.max(1, Math.floor(Number((msg as any).numTurns || 1)));
        if (!targetSid) {
          sendJson({ type: "codex_rollback_result", sessionId: "", success: false, error: "No Codex thread selected" });
          break;
        }
        const targetSession = activeSessions.get(targetSid) || (activeSession?.getSessionId() === targetSid ? activeSession : null);
        const sessionInfo = getSession(targetSid);
        const runRollback = targetSession instanceof CodexSession
          ? targetSession.rollbackAppServerThread(numTurns, targetSid)
          : sessionInfo?.backend === "codex"
            ? rollbackCodexAppServerThread(targetSid, sessionInfo.cwd, numTurns)
            : Promise.reject(new Error("Codex rollback is only supported for Codex threads"));
        runRollback.then(() => {
          appendHistory(targetSid, {
            role: "system",
            content: `Rolled back ${numTurns} Codex turn${numTurns === 1 ? "" : "s"}`,
            timestamp: new Date().toISOString(),
          } as any);
          sendJson({ type: "codex_rollback_result", sessionId: targetSid, success: true, numTurns });
        }).catch((e: any) => {
          sendJson({ type: "codex_rollback_result", sessionId: targetSid, success: false, numTurns, error: e.message || String(e) });
          sendJson({ type: "error", message: `Codex rollback failed: ${e.message || String(e)}` });
        });
        break;
      }

      case "archive_session": {
        const sid = (msg as any).sessionId as string;
        let sessionInfo = getSession(sid);
        let foundNativeOnly = false;
        if (!sessionInfo) {
          if (isCodexThreadArchived(sid)) {
            deleteSession(sid);
            invalidateCodexNativeListCache();
            console.log(`[Archive] Native Codex thread ${sid} is already archived`);
            sendJson({ type: "session_archived", sessionId: sid });
            broadcastSessionList();
            break;
          }
          sessionInfo =
            await getCodexNativeThreadSessionInfo(sid, getDefaultCwd()) ||
            await getClaudeNativeSessionInfo(sid) ||
            undefined;
          if (!sessionInfo) {
            console.warn(`[Archive] Session ${sid} not found in SocketAgent store or native backends`);
            sendJson({ type: "session_archive_failed", sessionId: sid, error: "Session not found" });
            break;
          }
          foundNativeOnly = true;
        }
        if (sessionInfo) {
          const running = activeSessions.get(sid);
          if (running) {
            running.abort();
            activeSessions.delete(sid);
          }
          if (sessionInfo.backend === "codex" && getStoredCodexDriver(sessionInfo) === "app-server") {
            try {
              await archiveCodexAppServerThread(sid, sessionInfo.cwd);
            } catch (err: any) {
              if (isCodexThreadArchived(sid)) {
                console.warn(`[Archive] Codex archive reported an error after ${sid} was archived: ${err.message || err}`);
                invalidateCodexNativeListCache();
                deleteSession(sid);
                sendJson({ type: "session_archived", sessionId: sid });
                broadcastSessionList();
                break;
              }
              const message = `Codex archive failed: ${err.message || err}`;
              console.warn(`[Archive] ${message} (${sid})`);
              sendJson({ type: "session_archive_failed", sessionId: sid, error: message });
              break;
            }
            invalidateCodexNativeListCache();
            deleteSession(sid);
            console.log(`Archived Codex thread ${sid} through native Codex archive`);
            sendJson({ type: "session_archived", sessionId: sid });
            broadcastSessionList();
            break;
          }
          if (foundNativeOnly) {
            saveSession(sessionInfo);
          }
          clearSessionContext(sid, sessionInfo.cwd);
          markSessionArchived(sid);
          deleteSession(sid);
          console.log(`Archived session ${sid}`);
          sendJson({ type: "session_archived", sessionId: sid });
          broadcastSessionList();
        }
        break;
      }

      case "list_archives": {
        sendJson({ type: "archive_list", archives: await listArchivesWithNativeCodex() });
        break;
      }

      case "get_archive_history": {
        const { sid, ts } = msg as any;
        const entries = isCodexNativeArchiveTs(ts)
          ? await readCodexAppServerThreadHistory(sid)
          : getArchiveHistory(sid, ts);
        sendJson({ type: "archive_history", sid, ts, messages: entries });
        break;
      }

      case "restore_archive": {
        const { sid, ts } = msg as any;
        try {
          if (isCodexNativeArchiveTs(ts)) {
            const existing = getSession(sid);
            const result = await restoreCodexNativeArchive(sid, existing?.cwd || getDefaultCwd());
            if (result.ok) {
              sendJson({ type: "archive_restored", sid, ts, session: result.session });
              broadcastSessionList();
            } else {
              sendJson({ type: "archive_restore_failed", sid, ts, reason: result.reason });
            }
            break;
          }
          const result = restoreArchive(sid, ts);
          if (result.ok) {
            if (result.session.backend === "codex" && (result.session as any).codexDriver === "app-server" && !isCodexNativeArchiveTs(ts)) {
              await unarchiveCodexAppServerThread(sid, result.session.cwd).catch((err) => {
                console.warn(`[RestoreArchive] Codex app-server thread/unarchive failed for ${sid}: ${err.message || err}`);
              });
              invalidateCodexNativeListCache();
            }
            sendJson({ type: "archive_restored", sid, ts, session: result.session });
            broadcastSessionList();
          } else {
            sendJson({ type: "archive_restore_failed", sid, ts, reason: result.reason });
          }
        } catch (e: any) {
          console.error(`[RestoreArchive] Exception: ${e.message}`, e.stack);
          sendJson({ type: "archive_restore_failed", sid, ts, reason: e.message || String(e) });
        }
        break;
      }

      case "delete_archive": {
        const { sid, ts } = msg as any;
        if (isCodexNativeArchiveTs(ts)) {
          sendJson({ type: "error", message: "Codex native archives cannot be permanently deleted through SocketAgent yet. Unarchive or keep them archived." });
          sendJson({ type: "archive_list", archives: await listArchivesWithNativeCodex(false) });
          break;
        }
        deleteArchive(sid, ts);
        sendJson({ type: "archive_deleted", sid, ts });
        sendJson({ type: "archive_list", archives: await listArchivesWithNativeCodex(false) });
        break;
      }

      case "auth_code": {
        const code = (msg as any).code as string;
        const authRequestId = (msg as any).authRequestId as string | undefined;
        if (authRequestId && pendingClaudeBackendAuth.has(authRequestId)) {
          const pending = pendingClaudeBackendAuth.get(authRequestId)!;
          pending.sendProgress({
            phase: "auth",
            status: "running",
            message: "Finishing Claude sign-in...",
          });
          exchangeClaudeAuthCode(pending.request, code)
            .then(() => {
              clearBackendHealthOverride("claude");
              refreshClaudeExecutableInfo();
              invalidateBackendHealthCache();
              finishClaudeBackendAuth(authRequestId, {
                phase: "probe",
                status: "completed",
                message: "Claude sign-in completed.",
              });
              sendJson({
                type: "server_settings",
                ...getAdvertisedServerSettings(),
                codexCollaborationMode: pendingCodexCollaborationMode,
              });
              broadcastSessionList();
            })
            .catch((e: any) => {
              finishClaudeBackendAuth(authRequestId, {
                phase: "auth",
                status: "failed",
                message: `Claude sign-in failed: ${e?.message || String(e)}`,
              });
            });
          break;
        }

        const targetSid = (msg as any).sessionId || activeSessionId;
        const session = targetSid ? activeSessions.get(targetSid) : null;
        if (session) {
          session.submitAuthCode(code);
        } else if (activeSession) {
          activeSession.submitAuthCode(code);
        } else {
          sendJson({ type: "error", message: "No active session for auth code" });
        }
        break;
      }

      case "abort": {
        // Always use the explicit session ID from the client
        const targetSid = msg.sessionId || activeSessionId;
        if (!targetSid) {
          console.log(`[Abort] No session ID provided and no active session`);
          break;
        }
        const targetSession = activeSessions.get(targetSid);
        if (targetSession) {
          console.log(`[Abort] Aborting session ${targetSid} (isRunning=${targetSession.isRunning})`);
          targetSession.abort();
          activeSessions.delete(targetSid);
          broadcastStatusSync();
        } else if (activeSession && activeSessionId === targetSid) {
          console.log(`[Abort] Aborting connection-local session ${targetSid}`);
          activeSession.abort();
          broadcastStatusSync();
        } else {
          console.log(`[Abort] Session ${targetSid} not found in activeSessions`);
        }
        break;
      }

      case "interrupt": {
        if (activeSession) {
          console.log(`Interrupting active session (graceful pause)`);
          activeSession.interrupt();
        }
        break;
      }

      case "secure_input_response": {
        const requestId = (msg as any).requestId as string;
        if (!requestId) {
          sendJson({ type: "error", message: "Missing secure input requestId" });
          break;
        }
        if ((msg as any).cancelled) {
          cancelSecureInputRequest(requestId);
          sendJson({ type: "secure_input_cancelled", requestId });
          break;
        }
        const value = (msg as any).value;
        if (typeof value !== "string" || value.length === 0) {
          sendJson({ type: "error", message: "Secure input value is empty" });
          break;
        }
        try {
          const saved = completeSecureInputRequest(requestId, value);
          sendJson({
            type: "secure_input_saved",
            requestId,
            sessionId: saved.sessionId || activeSessionId || "",
            secretId: saved.secretId,
            label: saved.label,
            scope: saved.scope,
            filePath: saved.filePath,
            envHint: saved.envHint,
          });
        } catch (e: any) {
          sendJson({ type: "error", message: `Secure input failed: ${e.message || String(e)}` });
        }
        break;
      }

      case "secure_input_store": {
        const value = (msg as any).value;
        const label = ((msg as any).label as string | undefined)?.trim() || "Secret";
        if (typeof value !== "string" || value.length === 0) {
          sendJson({ type: "error", message: "Secure input value is empty" });
          break;
        }
        try {
          const sessionId = ((msg as any).sessionId as string | undefined)?.trim()
            || activeSession?.getSessionId?.()
            || activeSessionId
            || undefined;
          const cwd = ((msg as any).cwd as string | undefined)?.trim()
            || activeSession?.getCwd?.()
            || (sessionId ? getSession(sessionId)?.cwd : undefined)
            || getDefaultCwd();
          const saved = saveSecureInput({
            label,
            value,
            reason: (msg as any).reason as string | undefined,
            envHint: (msg as any).envHint as string | undefined,
            scope: (msg as any).scope as any,
            sessionId,
            cwd,
          });
          sendJson({
            type: "secure_input_saved",
            sessionId: saved.sessionId || "",
            secretId: saved.secretId,
            label: saved.label,
            scope: saved.scope,
            filePath: saved.filePath,
            envHint: saved.envHint,
          });
        } catch (e: any) {
          sendJson({ type: "error", message: `Secure input failed: ${e.message || String(e)}` });
        }
        break;
      }

      case "set_tts": {
        const enabled = (msg as any).enabled === true;
        pendingTtsEnabled = enabled;
        if (activeSession) {
          activeSession.setTtsEnabled(enabled);
        }
        console.log(`TTS preference set to ${enabled} (session ${activeSession ? 'active' : 'pending'})`);
        break;
      }

      case "set_tts_engine": {
        const engine = (msg as any).engine as string;
        if (["system", "kokoro_server", "kokoro_device"].includes(engine)) {
          pendingTtsEngine = engine as any;
          if ((msg as any).voice) pendingKokoroVoice = (msg as any).voice;
          if ((msg as any).speed) pendingKokoroSpeed = (msg as any).speed;
          if (activeSession) {
            activeSession.setTtsEngine(engine as any);
            if ((msg as any).voice) activeSession.setKokoroVoice((msg as any).voice);
            if ((msg as any).speed) activeSession.setKokoroSpeed((msg as any).speed);
          }
          console.log(`TTS engine set to ${engine} voice=${pendingKokoroVoice} (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "request_tts_audio": {
        const text = (msg as any).text as string;
        const voice = (msg as any).voice as string || pendingKokoroVoice;
        const speed = (msg as any).speed as number || pendingKokoroSpeed;
        if (text) {
          try {
            const { generateKokoroAudio } = require("./kokoro-tts");
            const wavBuffer = generateKokoroAudio(text, voice, speed);
            if (wavBuffer) {
              sendJson({
                type: "tts_audio",
                audioData: wavBuffer.toString("base64"),
                text,
                sessionId: activeSession?.getSessionId() || "",
              });
            } else {
              sendJson({ type: "error", message: "Kokoro TTS model not available" });
            }
          } catch (e: any) {
            console.error("[KokoroTTS] request_tts_audio error:", e);
            sendJson({ type: "error", message: `TTS generation failed: ${e.message || e}` });
          }
        }
        break;
      }

      case "set_effort": {
        const effort = (msg as any).effort as string;
        if (['minimal', 'low', 'medium', 'high', 'max', 'xhigh'].includes(effort)) {
          pendingEffort = effort as any;
          if (activeSession) {
            activeSession.setEffort(effort as any);
          }
          console.log(`Effort set to ${effort} (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "set_codex_fast_mode": {
        pendingCodexFastMode = Boolean((msg as any).enabled);
        if (activeSession instanceof CodexSession) {
          activeSession.setCodexFastMode(pendingCodexFastMode);
        }
        console.log(`Codex fast mode ${pendingCodexFastMode ? "enabled" : "disabled"} (session ${activeSession ? 'active' : 'pending'})`);
        break;
      }

      case "set_claude_auto_compact": {
        pendingClaudeAutoCompact = Boolean((msg as any).enabled);
        if (activeSession && !(activeSession instanceof CodexSession)) {
          (activeSession as any).setClaudeAutoCompact?.(pendingClaudeAutoCompact);
        }
        console.log(`Claude auto-compact ${pendingClaudeAutoCompact ? "enabled" : "disabled"} (session ${activeSession ? 'active' : 'pending'})`);
        break;
      }

      case "set_thinking": {
        const thinking = (msg as any).thinking;
        if (thinking && ['adaptive', 'enabled', 'disabled'].includes(thinking.type)) {
          pendingThinking = thinking;
          if (activeSession) {
            activeSession.setThinking(thinking);
          }
          console.log(`Thinking set to ${JSON.stringify(thinking)} (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "set_disallowed_tools": {
        const tools = (msg as any).tools as string[];
        if (Array.isArray(tools)) {
          pendingDisallowedTools = tools;
          if (activeSession) {
            activeSession.setDisallowedTools(tools);
          }
          console.log(`Disallowed tools set to [${tools.join(', ')}] (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "set_system_prompt": {
        const prompt = (msg as any).prompt as string;
        if (typeof prompt === 'string') {
          pendingSystemPrompt = prompt;
          if (activeSession) {
            activeSession.setAppendSystemPrompt(prompt);
          }
          console.log(`System prompt set (${prompt.length} chars) (session ${activeSession ? 'active' : 'pending'})`);
        }
        break;
      }

      case "stop_task": {
        const taskId = (msg as any).taskId as string;
        console.log(`[stop_task] received: taskId=${taskId} activeSession=${!!activeSession}`);
        if (activeSession && taskId) {
          activeSession.stopTask(taskId).catch(e => console.error(`[stop_task] error: ${e}`));
        }
        break;
      }

      case "stop_monitor": {
        const monitorTaskId = (msg as any).taskId as string;
        console.log(`[stop_monitor] received: taskId=${monitorTaskId} activeSession=${!!activeSession}`);
        if (activeSession && monitorTaskId) {
          activeSession.stopMonitoring(monitorTaskId);
        }
        break;
      }

      case "set_model": {
        const model = (msg as any).model as string | undefined;
        if (activeSession) {
          activeSession.setModel(model).catch(e => {
            console.error(`[set_model] error: ${e}`);
            sendJson({ type: "error", message: `Failed to set model: ${e.message || e}` });
          });
        }
        break;
      }

      case "set_permission_mode": {
        const mode = (msg as any).mode as string;
        if (activeSession && mode) {
          activeSession.setPermissionMode(mode).catch(e => {
            console.error(`[set_permission_mode] error: ${e}`);
            sendJson({ type: "error", message: `Failed to set permission mode: ${(e as any).message || e}` });
          });
        }
        break;
      }

      case "skills_list": {
        console.log(`[skills_list] Handler entered`);
        try {
          let projectCwd: string | undefined;
          if (activeSession) {
            projectCwd = activeSession.getCwd?.();
          }
          if (!projectCwd) projectCwd = getDefaultCwd();
          console.log(`[skills_list] Scanning skills in ${projectCwd}...`);
          const skills = listSkills(projectCwd);
          console.log(`[skills_list] Found ${skills.length} skills, sending response`);
          sendJson({ type: "skills_list", skills, projectCwd, codexSlashCommands: CODEX_NATIVE_SLASH_COMMANDS });
        } catch (e: any) {
          console.error(`[skills_list] Error: ${e.message || e}`);
          sendJson({ type: "skills_list", skills: [], projectCwd: "", codexSlashCommands: CODEX_NATIVE_SLASH_COMMANDS, error: e.message || String(e) });
        }
        break;
      }

      case "codex_slash_command": {
        const name = String((msg as any).name || "").replace(/^\//, "").trim();
        const args = String((msg as any).args || "");
        const targetSid = String((msg as any).sessionId || activeSession?.getSessionId?.() || activeSessionId || "");
        const activeMatchesTarget = !!activeSession && (
          activeSession.getSessionId?.() === targetSid ||
          activeSessionId === targetSid ||
          (activeSession as any)._resumeSessionId === targetSid
        );
        const target = targetSid
          ? activeSessions.get(targetSid) || (activeMatchesTarget ? activeSession : null)
          : activeSession;
        if (!(target instanceof CodexSession)) {
          sendJson({ type: "error", message: "No active Codex session for slash command" });
          break;
        }
        const resultSessionId = targetSid || target.getSessionId?.() || (target as any)._resumeSessionId || "";
        target.executeCodexSlashCommand(name, args).then(() => {
          sendJson({ type: "codex_slash_command_result", sessionId: resultSessionId, name, success: true });
          broadcastSessionList();
        }).catch((e: any) => {
          const message = e.message || String(e);
          console.error(`[codex_slash_command] /${name} failed: ${message}`);
          const sessionId = resultSessionId;
          if (sessionId) {
            appendHistory(sessionId, {
              role: "notification",
              content: `/${name || "command"}\nFailed: ${message}`,
              status: "failed",
              originToolUseId: `codex_slash_${name || "command"}`,
              commandName: name || "command",
              commandPayload: { error: message },
              timestamp: new Date().toISOString(),
            } as any);
          }
          sendJson({
            type: "codex_command_result",
            taskId: `codex_slash_${name || "command"}_${crypto.randomUUID()}`,
            command: name || "command",
            status: "failed",
            summary: `/${name || "command"}\nFailed: ${message}`,
            payload: { error: message },
            sessionId,
            parentToolUseId: `codex_slash_${name || "command"}`,
          });
          sendJson({ type: "codex_slash_command_result", sessionId, name, success: false, error: message });
        });
        break;
      }

      case "skills_save": {
        const data = msg as any;
        if (!data.name || !data.format || !data.scope) {
          sendJson({ type: "skills_save_result", ok: false, error: "Missing required fields" });
          break;
        }
        try {
          let projectCwd: string | undefined;
          if (activeSession) projectCwd = activeSession.getCwd?.();
          if (!projectCwd) projectCwd = getDefaultCwd();
          const savedPath = saveSkill({
            filePath: data.filePath || undefined,
            name: data.name,
            scope: data.scope,
            format: data.format,
            agent: data.agent === "codex" ? "codex" : "claude",
            frontmatter: data.frontmatter || {},
            body: data.body || "",
            projectCwd,
          });
          sendJson({ type: "skills_save_result", ok: true, filePath: savedPath });
        } catch (err: any) {
          sendJson({ type: "skills_save_result", ok: false, error: err.message || "Save failed" });
        }
        break;
      }

      case "skills_delete": {
        const data = msg as any;
        if (!data.filePath) {
          sendJson({ type: "skills_delete_result", ok: false, error: "Missing filePath" });
          break;
        }
        const home = require("os").homedir();
        const normalized = require("path").resolve(data.filePath);
        const isUserScope =
          normalized.startsWith(require("path").join(home, ".claude")) ||
          normalized.startsWith(require("path").join(home, ".codex"));
        let isProjectScope = false;
        let projectCwd: string | undefined;
        if (activeSession) projectCwd = activeSession.getCwd?.();
        if (projectCwd) {
          isProjectScope =
            normalized.startsWith(require("path").join(projectCwd, ".claude")) ||
            normalized.startsWith(require("path").join(projectCwd, ".codex"));
        }
        if (!isUserScope && !isProjectScope) {
          sendJson({ type: "skills_delete_result", ok: false, error: "Cannot delete files outside .claude/.codex directories" });
          break;
        }
        const ok = deleteSkill(normalized);
        sendJson({ type: "skills_delete_result", ok });
        break;
      }

      case "protected_files_list": {
        const requestId = (msg as any).requestId;
        sendJson({
          type: "protected_files_list",
          requestId,
          entries: readProtectedFiles(),
        });
        break;
      }

      case "protected_files_add": {
        const requestId = (msg as any).requestId;
        const filePath = String((msg as any).path || "").trim();
        const label = String((msg as any).label || "").trim();
        if (!filePath) {
          sendJson({
            type: "protected_files_result",
            requestId,
            ok: false,
            error: "Missing path",
          });
          break;
        }
        try {
          const entries = readProtectedFiles();
          if (!entries.some((entry) => entry.path === filePath)) {
            entries.push({ path: filePath, ...(label ? { label } : {}) });
            writeProtectedFiles(entries);
          }
          sendJson({
            type: "protected_files_result",
            requestId,
            ok: true,
            entries,
          });
        } catch (err: any) {
          sendJson({
            type: "protected_files_result",
            requestId,
            ok: false,
            error: err.message || "Failed to add protected file",
          });
        }
        break;
      }

      case "protected_files_delete": {
        const requestId = (msg as any).requestId;
        const filePath = String((msg as any).path || "");
        if (!filePath) {
          sendJson({
            type: "protected_files_result",
            requestId,
            ok: false,
            error: "Missing path",
          });
          break;
        }
        try {
          const entries = readProtectedFiles().filter((entry) => entry.path !== filePath);
          writeProtectedFiles(entries);
          sendJson({
            type: "protected_files_result",
            requestId,
            ok: true,
            entries,
          });
        } catch (err: any) {
          sendJson({
            type: "protected_files_result",
            requestId,
            ok: false,
            error: err.message || "Failed to delete protected file",
          });
        }
        break;
      }

      case "plugins_list": {
        try {
          const mpPlugins = listMarketplacePlugins();
          sendJson({ type: "plugins_list", plugins: mpPlugins });
        } catch (e: any) {
          sendJson({ type: "plugins_list", plugins: [], error: e.message || String(e) });
        }
        break;
      }

      case "plugins_install":
      case "plugins_uninstall":
      case "plugins_enable":
      case "plugins_disable": {
        const data = msg as any;
        const pluginId = data.pluginId as string;
        const action = (msg.type as string).replace("plugins_", "") as "install" | "uninstall" | "enable" | "disable";
        if (!pluginId) {
          sendJson({ type: `plugins_${action}_result`, ok: false, error: "Missing pluginId" });
          break;
        }
        runPluginCommand(action, pluginId).then(() => {
          const mpPlugins = listMarketplacePlugins();
          sendJson({ type: `plugins_${action}_result`, pluginId, ok: true, plugins: mpPlugins });
        }).catch((e: any) => {
          sendJson({ type: `plugins_${action}_result`, pluginId, ok: false, error: e.message || String(e) });
        });
        break;
      }

      case "marketplaces_list": {
        try {
          sendJson({ type: "marketplaces_list", marketplaces: listMarketplaces() });
        } catch (e: any) {
          sendJson({ type: "marketplaces_list", marketplaces: [], error: e.message || String(e) });
        }
        break;
      }

      case "marketplaces_add": {
        const url = (msg as any).url as string;
        if (!url) {
          sendJson({ type: "marketplaces_add_result", ok: false, error: "Missing url" });
          break;
        }
        addMarketplace(url).then((info) => {
          sendJson({ type: "marketplaces_add_result", ok: true, marketplace: info, marketplaces: listMarketplaces() });
        }).catch((e: any) => {
          sendJson({ type: "marketplaces_add_result", ok: false, error: e.message || String(e) });
        });
        break;
      }

      case "marketplaces_update": {
        const mpName = (msg as any).name as string;
        if (!mpName) {
          sendJson({ type: "marketplaces_update_result", ok: false, error: "Missing name" });
          break;
        }
        updateMarketplace(mpName).then((info) => {
          sendJson({ type: "marketplaces_update_result", ok: true, marketplace: info, marketplaces: listMarketplaces() });
        }).catch((e: any) => {
          sendJson({ type: "marketplaces_update_result", ok: false, error: e.message || String(e) });
        });
        break;
      }

      case "marketplaces_remove": {
        const rmName = (msg as any).name as string;
        if (!rmName) {
          sendJson({ type: "marketplaces_remove_result", ok: false, error: "Missing name" });
          break;
        }
        try {
          removeMarketplace(rmName);
          sendJson({ type: "marketplaces_remove_result", ok: true, name: rmName, marketplaces: listMarketplaces() });
        } catch (e: any) {
          sendJson({ type: "marketplaces_remove_result", ok: false, error: e.message || String(e) });
        }
        break;
      }

      case "mcp_status": {
        if (activeSession) {
          activeSession.mcpServerStatus().then(status => {
            sendJson({ type: "mcp_status", servers: status || [] });
          }).catch(e => {
            sendJson({ type: "error", message: `Failed to get MCP status: ${e.message || e}` });
          });
        }
        break;
      }

      case "get_context_usage": {
        if (activeSession instanceof CodexSession) {
          const usage = activeSession.lastUsage;
          if (usage) {
            sendJson({
              type: "context_usage",
              sessionId: activeSession.getSessionId() || activeSessionId || "",
              totalTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens,
              maxTokens: usage.contextWindow,
              remainingTokens: Math.max(0, usage.contextWindow - usage.inputTokens - usage.cacheReadTokens - usage.cacheCreateTokens),
              percentUsed: usage.contextWindow > 0
                ? (usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens) / usage.contextWindow
                : 0,
            });
          }
          break;
        }
        if (activeSession && activeSession.isRunning) {
          (activeSession as any).activeQuery?.getContextUsage().then((ctx: any) => {
            if (ctx) {
              sendJson({
                type: "context_usage",
                sessionId: activeSessionId || "",
                ...ctx,
              });
            }
          }).catch(() => {});
        }
        break;
      }

      case "get_codex_status": {
        if (activeSession instanceof CodexSession) {
          try {
            const threadId = activeSession.getSessionId() || activeSessionId || "";
            const result = await activeSession.buildStatusResult(threadId);
            sendJson({
              type: "codex_status",
              sessionId: threadId,
              summary: result.summary,
              payload: result.payload,
            });
          } catch (e: any) {
            sendJson({
              type: "codex_status",
              sessionId: activeSession.getSessionId() || activeSessionId || "",
              error: e.message || String(e),
            });
          }
        }
        break;
      }

      case "get_sdk_event_history": {
        const targetSid = (msg as any).sessionId || activeSession?.getSessionId?.() || activeSessionId;
        if (!targetSid) {
          sendJson({ type: "sdk_event_history", sessionId: "", events: [], total: 0, limit: 0 } as any);
          break;
        }
        const rawLimit = Number((msg as any).limit || 300);
        const limit = Math.max(1, Math.min(1000, Math.floor(rawLimit)));
        sendJson({
          type: "sdk_event_history",
          sessionId: targetSid,
          events: getSdkEvents(targetSid, limit),
          total: getSdkEventCount(targetSid),
          limit,
        } as any);
        break;
      }

      case "mcp_reconnect": {
        const serverName = (msg as any).serverName as string;
        if (activeSession && serverName) {
          activeSession.reconnectMcpServer(serverName).then(result => {
            sendJson({ type: "mcp_reconnect_result", serverName, success: true });
          }).catch(e => {
            sendJson({ type: "error", message: `Failed to reconnect ${serverName}: ${e.message || e}` });
          });
        }
        break;
      }

      case "mcp_toggle": {
        const serverName = (msg as any).serverName as string;
        const enabled = (msg as any).enabled as boolean;
        if (activeSession && serverName) {
          activeSession.toggleMcpServer(serverName, enabled).then(() => {
            sendJson({ type: "mcp_toggle_result", serverName, enabled });
          }).catch(e => {
            sendJson({ type: "error", message: `Failed to toggle ${serverName}: ${e.message || e}` });
          });
        }
        break;
      }

      case "rewind": {
        const uuid = (msg as any).userMessageUuid as string;
        const dryRun = (msg as any).dryRun === true;
        if (!activeSession) {
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No active session" });
        } else if (activeSession instanceof CodexSession) {
          const detail = "Codex App Server rollback is turn-level and does not restore workspace files for a message UUID.";
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: detail });
        } else if (!uuid) {
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No message UUID" });
        } else if (!activeSession.isRunning) {
          sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No active query — file-only rewind requires a running conversation. Use rewind_conversation to rewind when idle." });
        } else {
          activeSession.rewindFiles(uuid, dryRun).then(result => {
            if (!result) {
              sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: "No file checkpoint found at this message" });
            } else {
              sendJson({ type: "rewind_result", uuid, dryRun, success: true, ...result });
            }
          }).catch(e => {
            sendJson({ type: "rewind_result", uuid, dryRun, success: false, error: e.message || String(e) });
          });
        }
        break;
      }

      case "rewind_conversation": {
        const uuid = (msg as any).userMessageUuid as string;
        const dryRun = (msg as any).dryRun === true;
        const shouldRewindFiles = (msg as any).rewindFiles !== false; // default true
        const sessionId = activeSession?.getSessionId();

        if (!sessionId) {
          sendJson({ type: "rewind_conversation_result", sessionId: "", success: false, userMessageUuid: uuid, error: "No active session" });
          break;
        }
        if (!uuid) {
          sendJson({ type: "rewind_conversation_result", sessionId, success: false, userMessageUuid: uuid, error: "No message UUID" });
          break;
        }
        const rewindSessionInfo = getSession(sessionId);
        if (rewindSessionInfo?.backend === "codex" || activeSession instanceof CodexSession) {
          const detail = "Codex App Server currently exposes turn-count rollback, but not a safe message-level conversation rewind.";
          sendJson({ type: "rewind_conversation_result", sessionId, success: false, userMessageUuid: uuid, error: detail });
          break;
        }

        // Dry run: preview what would be removed without actually doing it
        if (dryRun) {
          const all = getHistory(sessionId);
          const idx = all.findIndex((e) => e.uuid === uuid);
          if (idx === -1) {
            sendJson({ type: "rewind_conversation_result", sessionId, success: false, userMessageUuid: uuid, dryRun: true, error: "Message UUID not found in history" });
          } else {
            const messagesRemoved = all.length - (idx + 1);
            // Also do a file rewind dry run if requested and query is active
            let fileInfo: any = {};
            if (shouldRewindFiles && activeSession?.isRunning) {
              try {
                const fileResult = await activeSession.rewindFiles(uuid, true);
                if (fileResult) {
                  fileInfo = { filesReverted: fileResult.filesChanged, insertions: fileResult.insertions, deletions: fileResult.deletions };
                }
              } catch {}
            }
            sendJson({ type: "rewind_conversation_result", sessionId, success: true, userMessageUuid: uuid, dryRun: true, messagesRemoved, ...fileInfo });
          }
          break;
        }

        // Actual rewind: abort active query, rewind files, truncate history, prepare for resume-at
        try {
          // Step 1: Rewind files (if requested) and abort active query
          if (activeSession && activeSession.isRunning) {
            if (shouldRewindFiles) {
              try {
                await activeSession.rewindFiles(uuid, false);
              } catch (e: any) {
                console.log(`[RewindConversation] File rewind failed (non-fatal): ${e.message || e}`);
              }
            }
            // Abort the current query
            activeSession.abort();
            activeSessions.delete(sessionId);
          }

          // Step 2: Truncate our local history
          const { removed } = truncateHistoryAtMessage(sessionId, uuid);

          // Step 3: Create a new session primed to resume-at this point
          const sessionInfo = getSession(sessionId);
          const cwd = sessionInfo?.cwd || activeSession?.getCwd() || getDefaultCwd() || process.env.HOME || "/";
          activeSession = createSession(sessionInfo?.backend, transport as any, cwd, plugins, getStoredCodexDriver(sessionInfo));
          await restorePersistedPermissionMode(activeSession, sessionInfo);
          activeSession.setTtsEnabled(pendingTtsEnabled);
          activeSession.setTtsEngine(pendingTtsEngine);
          activeSession.setKokoroVoice(pendingKokoroVoice);
          activeSession.setKokoroSpeed(pendingKokoroSpeed);
          activeSession.setEffort(pendingEffort as any);
          activeSession.setThinking(pendingThinking);
          activeSession.setDisallowedTools(pendingDisallowedTools);
          activeSession.setAppendSystemPrompt(pendingSystemPrompt);
          (activeSession as any).setCodexCollaborationMode?.(pendingCodexCollaborationMode);
          (activeSession as any).setCodexFastMode?.(pendingCodexFastMode);
          (activeSession as any).setClaudeAutoCompact?.(pendingClaudeAutoCompact);
  
          activeSession.setResumeSessionAt(uuid);
          // Store the session ID so the next prompt resumes this session at the rewind point
          (activeSession as any)._resumeSessionId = sessionId;

          sendJson({
            type: "rewind_conversation_result",
            sessionId,
            success: true,
            userMessageUuid: uuid,
            messagesRemoved: removed >= 0 ? removed : 0,
          });

          // Send truncated history so app can update its UI
          const page = getHistoryPageToLastPrompt(sessionId);
          sendJson({
            type: "session_history",
            sessionId,
            messages: page.entries,
            total: page.total,
            offset: page.offset,
          });

          broadcastSessionList();
        } catch (e: any) {
          sendJson({ type: "rewind_conversation_result", sessionId, success: false, userMessageUuid: uuid, error: e.message || String(e) });
        }
        break;
      }

      case "branch_from_message": {
        const sourceId = (msg as any).sessionId as string;
        const branchUuid = (msg as any).userMessageUuid as string;
        if (!sourceId) {
          sendJson({ type: "branch_result", success: false, originalSessionId: "", branchPointUuid: branchUuid, error: "No session ID" });
          break;
        }
        if (!branchUuid) {
          sendJson({ type: "branch_result", success: false, originalSessionId: sourceId, branchPointUuid: "", error: "No branch point UUID" });
          break;
        }
        const sessionInfo = getSession(sourceId);
        if (!sessionInfo) {
          sendJson({ type: "branch_result", success: false, originalSessionId: sourceId, branchPointUuid: branchUuid, error: "Session not found" });
          break;
        }
        if (sessionInfo.backend === "codex") {
          const detail = "Codex App Server currently exposes full thread fork and turn-count rollback, but not a safe branch-at-message operation.";
          sendJson({ type: "branch_result", success: false, originalSessionId: sourceId, branchPointUuid: branchUuid, error: detail });
          break;
        }

        try {
          // Use SDK's forkSession with upToMessageId to create a branch at the specific message
          const { forkSession: sdkFork } = require("@anthropic-ai/claude-agent-sdk");
          const result = await sdkFork(sourceId, {
            upToMessageId: branchUuid,
            dir: sessionInfo.cwd,
          });

          const newSessionId = result.sessionId;

          // Copy truncated history for the new branch
          const allHistory = getHistory(sourceId);
          const branchIdx = allHistory.findIndex((e) => e.uuid === branchUuid);
          if (branchIdx !== -1) {
            const branchHistory = allHistory.slice(0, branchIdx + 1);
            appendHistoryBulk(newSessionId, branchHistory);
          }

          // Save the new session in our store
          saveSession({
            id: newSessionId,
            title: `${sessionInfo.title || "Untitled"} (branch)`,
            cwd: sessionInfo.cwd,
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            messagePreview: `Branched from ${sourceId.substring(0, 8)}...`,
          });

          // Detach current session if running
          if (activeSession && activeSession.isRunning) {
            activeSession.detachWebSocket();
          }

          // Set up new session ready to resume the fork
          activeSession = createSession(sessionInfo.backend, transport as any, sessionInfo.cwd, plugins, getStoredCodexDriver(sessionInfo));
          activeSession.setTtsEnabled(pendingTtsEnabled);
          activeSession.setTtsEngine(pendingTtsEngine);
          activeSession.setKokoroVoice(pendingKokoroVoice);
          activeSession.setKokoroSpeed(pendingKokoroSpeed);
          activeSession.setEffort(pendingEffort as any);
          activeSession.setThinking(pendingThinking);
          activeSession.setDisallowedTools(pendingDisallowedTools);
          activeSession.setAppendSystemPrompt(pendingSystemPrompt);
          (activeSession as any).setCodexCollaborationMode?.(pendingCodexCollaborationMode);
          (activeSession as any).setCodexFastMode?.(pendingCodexFastMode);
  
          (activeSession as any)._resumeSessionId = newSessionId;

          sendJson({
            type: "branch_result",
            success: true,
            originalSessionId: sourceId,
            newSessionId,
            branchPointUuid: branchUuid,
            cwd: sessionInfo.cwd,
          });

          // Send the new session creation and history
          sendJson({
            type: "session_created",
            sessionId: newSessionId,
            cwd: sessionInfo.cwd,
          });

          const branchPage = getHistoryPage(newSessionId, 50);
          sendJson({
            type: "session_history",
            sessionId: newSessionId,
            messages: branchPage.entries,
            total: branchPage.total,
            offset: branchPage.offset,
          });

          broadcastSessionList();
          console.log(`Branched session ${sourceId} at message ${branchUuid} → new session ${newSessionId}`);
        } catch (e: any) {
          console.error(`[Branch] Failed: ${e.message || e}`);
          sendJson({ type: "branch_result", success: false, originalSessionId: sourceId, branchPointUuid: branchUuid, error: e.message || String(e) });
        }
        break;
      }

      case "fork_session": {
        const sourceId = (msg as any).sessionId as string;
        if (!sourceId) {
          sendJson({ type: "error", message: "No session ID to fork" });
          break;
        }
        const sessionInfo = getSession(sourceId);
        if (!sessionInfo) {
          sendJson({ type: "error", message: "Session not found" });
          break;
        }
        if (sessionInfo.backend === "codex") {
          try {
            if (activeSession && activeSession.isRunning) {
              activeSession.detachWebSocket();
            }
            const forked = new CodexSession(transport as any, sessionInfo.cwd, plugins);
            forked.setTtsEnabled(pendingTtsEnabled);
            forked.setTtsEngine(pendingTtsEngine);
            forked.setKokoroVoice(pendingKokoroVoice);
            forked.setKokoroSpeed(pendingKokoroSpeed);
            forked.setEffort(pendingEffort as any);
            forked.setThinking(pendingThinking);
            forked.setDisallowedTools(pendingDisallowedTools);
            forked.setAppendSystemPrompt(pendingSystemPrompt);
            forked.setCodexCollaborationMode(pendingCodexCollaborationMode);
            forked.setCodexFastMode(pendingCodexFastMode);
            const { threadId: newSessionId } = await forked.forkAppServerThread(sourceId);
            const sourceHistory = getHistory(sourceId);
            appendHistoryBulk(newSessionId, sourceHistory.map((entry) => ({ ...entry })));
            saveSession({
              id: newSessionId,
              title: `${sessionInfo.title || "Untitled"} (fork)`,
              cwd: sessionInfo.cwd,
              createdAt: new Date().toISOString(),
              lastActive: new Date().toISOString(),
              messagePreview: `Forked from ${sourceId.substring(0, 8)}...`,
              backend: "codex",
              codexDriver: "app-server",
            });
            activeSession = forked;
            activeSessionId = newSessionId;
            sessionClients.set(newSessionId, {
              ws: transport as WebSocket,
              setActiveSession: (s: Session) => { activeSession = s; },
            });
            sendJson({
              type: "session_forked",
              originalSessionId: sourceId,
              newSessionId,
              cwd: sessionInfo.cwd,
            });
            const forkPage = getHistoryPage(newSessionId, 50);
            sendJson({
              type: "session_history",
              sessionId: newSessionId,
              messages: forkPage.entries,
              total: forkPage.total,
              offset: forkPage.offset,
            });
            broadcastSessionList();
            console.log(`Forked Codex App Server session ${sourceId} → ${newSessionId}`);
          } catch (e: any) {
            console.error(`[Fork] Codex app-server fork failed: ${e.message || e}`);
            sendJson({ type: "error", message: `Codex fork failed: ${e.message || String(e)}` });
          }
          break;
        }
        if (activeSession && activeSession.isRunning) {
          activeSession.detachWebSocket();
        }
        activeSession = createSession(sessionInfo.backend, transport as any, sessionInfo.cwd, plugins, getStoredCodexDriver(sessionInfo));
        await restorePersistedPermissionMode(activeSession, sessionInfo);
        activeSession.setTtsEnabled(pendingTtsEnabled);
        activeSession.setTtsEngine(pendingTtsEngine);
        activeSession.setKokoroVoice(pendingKokoroVoice);
        activeSession.setKokoroSpeed(pendingKokoroSpeed);
        activeSession.setEffort(pendingEffort as any);
        activeSession.setThinking(pendingThinking);
        activeSession.setDisallowedTools(pendingDisallowedTools);
        activeSession.setAppendSystemPrompt(pendingSystemPrompt);
        (activeSession as any).setCodexCollaborationMode?.(pendingCodexCollaborationMode);
        (activeSession as any).setCodexFastMode?.(pendingCodexFastMode);
        (activeSession as any).setClaudeAutoCompact?.(pendingClaudeAutoCompact);

        activeSession.setForkSource(sourceId);
        sendJson({
          type: "session_created",
          sessionId: "",
          cwd: sessionInfo.cwd,
          title: "Untitled",
        });
        const forkPage = getHistoryPage(sourceId, 50);
        sendJson({
          type: "session_history",
          sessionId: sourceId,
          messages: forkPage.entries,
          total: forkPage.total,
          offset: forkPage.offset,
        });
        console.log(`Forking session ${sourceId} (cwd=${sessionInfo.cwd})`);
        break;
      }

      case "load_more_history": {
        const sessionId = (msg as any).sessionId as string;
        const offset = (msg as any).offset as number;
        const limit = (msg as any).limit as number || 50;
        if (!sessionId) break;
        const page = getHistoryPage(sessionId, limit, offset);
        sendJson({
          type: "session_history",
          sessionId,
          messages: page.entries,
          total: page.total,
          offset: page.offset,
        });
        break;
      }

      case "check_cwd": {
        const checkPath = (msg as any).path as string;
        const requestId = (msg as any).requestId;
        sendCwdCheck(sendJson, checkPath, typeof requestId === "string" ? { requestId } : {});
        break;
      }

      case "create_cwd": {
        const createPath = (msg as any).path as string;
        const requestId = (msg as any).requestId;
        const responseMeta = typeof requestId === "string" ? { requestId } : {};
        const resolved = resolveClientPath(createPath);
        if (!resolved.inputPath) {
          sendCwdCheck(sendJson, createPath, responseMeta);
          break;
        }
        try {
          fs.mkdirSync(resolved.resolvedPath, { recursive: true });
          sendCwdCheck(sendJson, createPath, { ...responseMeta, created: true });
        } catch (e: any) {
          sendCwdCheck(sendJson, createPath, {
            ...responseMeta,
            createFailed: true,
            error: `Failed to create directory: ${e?.message || String(e)}`,
            errorCode: e?.code,
          });
        }
        break;
      }

      case "list_directory" as any: {
        const listPath = (msg as any).path as string || getDefaultCwd();
        try {
          const resolvedPath = path.resolve(listPath);
          const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
          const dirs: string[] = [];
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              dirs.push(entry.name);
            }
          }
          dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
          sendJson({
            type: "directory_listing",
            path: resolvedPath,
            directories: dirs,
          });
        } catch (e: any) {
          sendJson({
            type: "directory_listing",
            path: listPath,
            directories: [],
            error: e.message,
          });
        }
        break;
      }

      case "file_manager_list" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        try {
          const listing = listFileManagerDirectory({
            dirPath: (msg as any).path as string | undefined,
            includeHidden: (msg as any).includeHidden === true,
            defaultCwd: getDefaultCwd(),
          });
          sendJson({
            type: "file_manager_list_result",
            requestId,
            ok: true,
            ...listing,
          });
        } catch (e: any) {
          sendJson({
            type: "file_manager_list_result",
            requestId,
            ok: false,
            path: (msg as any).path || getDefaultCwd(),
            entries: [],
            roots: [],
            error: e.message || String(e),
          });
        }
        break;
      }

      case "file_manager_set_protected" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const filePath = String((msg as any).path || "").trim();
        const protect = (msg as any).protected === true;
        const label = String((msg as any).label || "").trim();
        const pattern = (msg as any).pattern === "directory" ? "directory" : "exact";
        if (!filePath) {
          sendJson({
            type: "file_manager_protected_result",
            requestId,
            ok: false,
            path: filePath,
            protected: false,
            error: "Missing path",
          });
          break;
        }
        try {
          const result = protect
            ? setProtectedFile(filePath, true, { label, pattern })
            : removeMatchingProtection(filePath);
          sendJson({
            type: "file_manager_protected_result",
            requestId,
            ok: true,
            path: filePath,
            protected: protect,
            ...(result.entry ? { entry: result.entry } : {}),
            ...(result.removed ? { removed: result.removed } : {}),
            entries: result.entries,
          });
        } catch (e: any) {
          sendJson({
            type: "file_manager_protected_result",
            requestId,
            ok: false,
            path: filePath,
            protected: !protect,
            error: e.message || String(e),
          });
        }
        break;
      }

      case "request_file": {
        const filePath = (msg as any).filePath as string;
        const fileId = (msg as any).fileId as string;
        const offsetBytes = Number((msg as any).offsetBytes || 0);
        try {
          const { resolvedPath } = resolveAllowedDownloadFile(filePath);
          await sendFileChunks(resolvedPath, fileId, Number.isFinite(offsetBytes) ? offsetBytes : 0);
        } catch (e: any) {
          sendJson({ type: "error", message: e.message || String(e) });
        }
        break;
      }

      case "file_manager_download" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const filePath = String((msg as any).path || "");
        const fileId = (msg as any).fileId as string || `fm_${crypto.randomUUID()}`;
        try {
          const { resolvedPath } = resolveAllowedDownloadFile(filePath);
          sendJson({
            type: "file_manager_operation_result",
            requestId,
            operation: "download",
            ok: true,
            path: resolvedPath,
            fileId,
          });
          const offsetBytes = Number((msg as any).offsetBytes || 0);
          await sendFileChunks(resolvedPath, fileId, Number.isFinite(offsetBytes) ? offsetBytes : 0);
        } catch (e: any) {
          sendJson({
            type: "file_manager_operation_result",
            requestId,
            operation: "download",
            ok: false,
            path: filePath,
            error: e.message || String(e),
          });
        }
        break;
      }

      case "file_manager_read_text" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const filePath = String((msg as any).path || "");
        try {
          const roots = getFileManagerRoots(getDefaultCwd());
          const resolved = resolveFileManagerPath(filePath, getDefaultCwd());
          assertFileManagerPathAllowed(resolved, roots);
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
          const requestedMax = Number((msg as any).maxBytes || 512 * 1024);
          const maxBytes = Math.min(Math.max(requestedMax, 1024), 1024 * 1024);
          const fd = fs.openSync(resolved, "r");
          try {
            const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
            const truncated = bytesRead > maxBytes || stat.size > maxBytes;
            const content = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
            sendJson({
              type: "file_manager_text_result",
              requestId,
              ok: true,
              path: resolved,
              content,
              truncated,
              bytesRead: Math.min(bytesRead, maxBytes),
            });
          } finally {
            fs.closeSync(fd);
          }
        } catch (e: any) {
          sendJson({
            type: "file_manager_text_result",
            requestId,
            ok: false,
            path: filePath,
            error: e.message || String(e),
          });
        }
        break;
      }

      case "file_manager_mkdir" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const targetPath = String((msg as any).path || "");
        try {
          const roots = getFileManagerRoots(getDefaultCwd());
          const resolved = resolveFileManagerPath(targetPath, getDefaultCwd());
          assertFileManagerPathAllowed(resolved, roots);
          fs.mkdirSync(resolved, { recursive: true });
          sendJson({ type: "file_manager_operation_result", requestId, operation: "mkdir", ok: true, path: resolved });
        } catch (e: any) {
          sendJson({ type: "file_manager_operation_result", requestId, operation: "mkdir", ok: false, path: targetPath, error: e.message || String(e) });
        }
        break;
      }

      case "file_manager_rename" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const fromPath = String((msg as any).fromPath || "");
        const toName = String((msg as any).toName || "");
        try {
          const roots = getFileManagerRoots(getDefaultCwd());
          const resolvedFrom = resolveFileManagerPath(fromPath, getDefaultCwd());
          assertFileManagerPathAllowed(resolvedFrom, roots);
          const cleanName = path.basename(toName);
          if (!cleanName || cleanName !== toName || cleanName === "." || cleanName === "..") {
            throw new Error("Invalid destination name");
          }
          const resolvedTo = path.join(path.dirname(resolvedFrom), cleanName);
          assertFileManagerPathAllowed(resolvedTo, roots);
          if (fs.existsSync(resolvedTo)) throw new Error(`Destination already exists: ${resolvedTo}`);
          fs.renameSync(resolvedFrom, resolvedTo);
          sendJson({ type: "file_manager_operation_result", requestId, operation: "rename", ok: true, path: resolvedFrom, newPath: resolvedTo });
        } catch (e: any) {
          sendJson({ type: "file_manager_operation_result", requestId, operation: "rename", ok: false, path: fromPath, error: e.message || String(e) });
        }
        break;
      }

      case "file_manager_delete" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const targetPath = String((msg as any).path || "");
        const recursive = (msg as any).recursive === true;
        try {
          const roots = getFileManagerRoots(getDefaultCwd());
          const resolved = resolveFileManagerPath(targetPath, getDefaultCwd());
          assertFileManagerPathAllowed(resolved, roots);
          const stat = fs.lstatSync(resolved);
          if (stat.isDirectory() && !recursive) {
            fs.rmdirSync(resolved);
          } else if (stat.isDirectory()) {
            fs.rmSync(resolved, { recursive: true, force: false });
          } else {
            fs.unlinkSync(resolved);
          }
          sendJson({ type: "file_manager_operation_result", requestId, operation: "delete", ok: true, path: resolved });
        } catch (e: any) {
          sendJson({ type: "file_manager_operation_result", requestId, operation: "delete", ok: false, path: targetPath, error: e.message || String(e) });
        }
        break;
      }

      case "file_manager_upload_start" as any: {
        const requestId = (msg as any).requestId as string | undefined;
        const uploadId = String((msg as any).uploadId || "");
        try {
          const filePath = resolveUploadTarget(
            String((msg as any).targetDir || ""),
            String((msg as any).fileName || "upload"),
            String((msg as any).conflictPolicy || "rename"),
          );
          const fd = fs.openSync(filePath, "w");
          activeUploads.set(uploadId, {
            fd,
            filePath,
            fileName: path.basename(filePath),
            receivedChunks: 0,
            totalChunks: (msg as any).totalChunks,
            chunkSize: (msg as any).chunkSize || 512 * 1024,
            totalBytes: (msg as any).fileSize,
            bytesReceived: 0,
            lastProgressEmit: 0,
          });
          sendJson({
            type: "file_manager_operation_result",
            requestId,
            operation: "upload_start",
            ok: true,
            path: filePath,
            uploadId,
          });
        } catch (e: any) {
          sendJson({
            type: "file_manager_operation_result",
            requestId,
            operation: "upload_start",
            ok: false,
            error: e.message || String(e),
            uploadId,
          });
        }
        break;
      }

      case "upload_start": {
        const uploadId = msg.uploadId;
        const fileName = path.basename(msg.fileName || "upload"); // sanitize: strip path traversal
        const fileSize = msg.fileSize;
        const totalChunks = msg.totalChunks;
        const chunkSize = (msg as any).chunkSize || 512 * 1024;

        const cwd = activeSession?.getCwd() || getDefaultCwd();
        const uploadDir = path.join(cwd, ".uploads");
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        let filePath = path.join(uploadDir, fileName);
        let counter = 1;
        while (fs.existsSync(filePath)) {
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          filePath = path.join(uploadDir, `${base} (${counter})${ext}`);
          counter++;
        }

        const fd = fs.openSync(filePath, "w");
        activeUploads.set(uploadId, {
          fd,
          filePath,
          fileName,
          receivedChunks: 0,
          totalChunks,
          chunkSize,
          totalBytes: fileSize,
          bytesReceived: 0,
          lastProgressEmit: 0,
        });
        console.log(`Upload started: ${fileName} (${totalChunks} chunks @ ${(chunkSize / 1024).toFixed(0)} KB, ${(fileSize / 1024).toFixed(1)} KB total)`);
        break;
      }

      case "upload_chunk": {
        const uploadId = msg.uploadId;
        const chunkIndex = msg.chunkIndex;
        const data = msg.data as string;
        const upload = activeUploads.get(uploadId);
        if (!upload) {
          sendJson({ type: "error", message: `Unknown upload: ${uploadId}` });
          break;
        }

        const bytes = Buffer.from(data, "base64");
        fs.writeSync(upload.fd, bytes, 0, bytes.length, chunkIndex * upload.chunkSize);
        upload.receivedChunks++;
        upload.bytesReceived += bytes.length;
        console.log(`[Upload] chunk ${upload.receivedChunks}/${upload.totalChunks} (legacy base64) ${(upload.bytesReceived / 1024 / 1024).toFixed(1)} MB`);
        maybeEmitUploadProgress(uploadId);

        if (upload.receivedChunks >= upload.totalChunks) {
          fs.closeSync(upload.fd);
          maybeEmitUploadProgress(uploadId, true);  // final 100% tick
          activeUploads.delete(uploadId);
          sendJson({
            type: "upload_complete",
            uploadId,
            serverPath: upload.filePath,
          });
          console.log(`Upload complete: ${upload.fileName} -> ${upload.filePath}`);
        }
        break;
      }

      case "upload_chunk_bin": {
        const uploadId = (msg as any).uploadId as string;
        const chunkIndex = (msg as any).chunkIndex as number;
        const bytes = (msg as any).data as Buffer;
        const upload = activeUploads.get(uploadId);
        if (!upload) {
          sendJson({ type: "error", message: `Unknown upload: ${uploadId}` });
          break;
        }

        fs.writeSync(upload.fd, bytes, 0, bytes.length, chunkIndex * upload.chunkSize);
        upload.receivedChunks++;
        upload.bytesReceived += bytes.length;
        console.log(`[Upload] chunk ${upload.receivedChunks}/${upload.totalChunks} (binary) ${(upload.bytesReceived / 1024 / 1024).toFixed(1)} MB`);
        maybeEmitUploadProgress(uploadId);

        if (upload.receivedChunks >= upload.totalChunks) {
          fs.closeSync(upload.fd);
          maybeEmitUploadProgress(uploadId, true);
          activeUploads.delete(uploadId);
          sendJson({
            type: "upload_complete",
            uploadId,
            serverPath: upload.filePath,
          });
          console.log(`Upload complete: ${upload.fileName} -> ${upload.filePath}`);
        }
        break;
      }
    }
  }

  return {
    handleMessage,
    sendJson,
    sendRaw,
    close: closeConnection,
    get activeSessionId() { return activeSessionId; },
  };
}

const httpServer = http.createServer((req, res) => {
  if (isCodexAppMcpRequest(req)) {
    void handleCodexAppMcpRequest(req, res).catch((err) => {
      console.error(`[Codex MCP] Unhandled request error: ${err.message}`, err.stack);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        }));
      }
    });
    return;
  }

  // POST /continue — trigger a prompt on a session without a WebSocket (used by restart script)
  if (req.method === "POST" && req.url?.startsWith("/continue")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { sessionId, prompt } = JSON.parse(body);
        if (!sessionId || !prompt) {
          res.writeHead(400);
          res.end("Missing sessionId or prompt");
          return;
        }
        const sessionInfo = getSession(sessionId);
        if (!sessionInfo) {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }
        // Use the real WebSocket if a client is already connected for this session
        // (typical after restart: app reconnects before the continue script runs).
        // Otherwise fall back to a dummy so the query still runs headless.
        const existingClient = sessionClients.get(sessionId);
        const ws = existingClient?.ws?.readyState === WebSocket.OPEN
          ? existingClient.ws
          : { readyState: WebSocket.CLOSED, send: () => {} } as any;
        const session = createSession(sessionInfo.backend, ws, sessionInfo.cwd, plugins, getStoredCodexDriver(sessionInfo));
        await restorePersistedPermissionMode(session, sessionInfo);

        (session as any)._resumeSessionId = sessionId;
        attachSessionLifecycleCallbacks(session);

        // Register immediately so the app can find it when it reconnects
        activeSessions.set(sessionId, session);

        // Update the connection handler's active session so future messages
        // (prompts, answers, abort) from the app go to this running session
        if (existingClient) {
          existingClient.setActiveSession(session);
          console.log(`[Continue] Using existing WebSocket for session ${sessionId}`);
        }
        console.log(`[Continue] Starting query for session ${sessionId}`);

        const continueRunPromise = session.runQuery(prompt, sessionId);
        sendSessionStartedPush(session);
        continueRunPromise.then(() => {
          const sid = session.getSessionId() || sessionId;
          if (activeSessions.get(sid) === session && !sessionShouldRemainPooled(session)) {
            activeSessions.delete(sid);
          }
          sendSessionCompletionPush(session, "completed");
          broadcastSessionList();
        }).catch((err) => {
          console.error(`[Continue] Query error: ${err.message}`);
          if (!sessionShouldRemainPooled(session)) activeSessions.delete(sessionId);
          sendSessionCompletionPush(session, "failed", err.message || "Query failed");
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(err.message || "Server error");
      }
    });
    return;
  }

  // GET /running-sessions — return list of currently running session IDs (used by restart script)
  if (req.method === "GET" && req.url?.startsWith("/running-sessions")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    const running: string[] = [];
    for (const [sid, session] of activeSessions) {
      if (sessionIsBusy(session)) running.push(sid);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: running }));
    return;
  }

  // GET /download-file — fast direct-LAN file download for app file cards/file manager.
  // The WebSocket file transfer path remains the fallback for relay and old apps.
  if (req.method === "GET" && req.url?.startsWith("/download-file")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    let filePath: string;
    let stat: fs.Stats;
    try {
      const resolved = resolveAllowedDownloadFile(url.searchParams.get("path") || "");
      filePath = resolved.resolvedPath;
      stat = resolved.stat;
    } catch (e: any) {
      res.writeHead(403);
      res.end(e.message || "File download not allowed");
      return;
    }

    const fileName = path.basename(filePath).replace(/["\r\n]/g, "_");
    const fileSize = stat.size;
    if (fileSize === 0) {
      console.log(`[HTTP Download] Serving empty file ${fileName}`);
      res.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
        "Content-Length": "0",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      });
      res.end();
      return;
    }

    let start = 0;
    let end = fileSize - 1;
    let statusCode = 200;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match) {
        res.writeHead(416, {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${fileSize}`,
        });
        res.end();
        return;
      }

      const rawStart = match[1];
      const rawEnd = match[2];
      if (rawStart === "" && rawEnd !== "") {
        const suffixLength = Number.parseInt(rawEnd, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
          res.writeHead(416, {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${fileSize}`,
          });
          res.end();
          return;
        }
        start = Math.max(0, fileSize - suffixLength);
      } else if (rawStart !== "") {
        start = Number.parseInt(rawStart, 10);
      }
      if (rawEnd !== "" && rawStart !== "") {
        end = Number.parseInt(rawEnd, 10);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
        res.writeHead(416, {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${fileSize}`,
        });
        res.end();
        return;
      }
      end = Math.min(end, fileSize - 1);
      statusCode = 206;
    }

    const contentLength = end - start + 1;
    console.log(`[HTTP Download] Serving ${fileName} (${(contentLength / 1024 / 1024).toFixed(1)} MB${statusCode === 206 ? ` range=${start}-${end}/${fileSize}` : ""})`);
    res.writeHead(statusCode, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": contentLength.toString(),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${fileSize}` } : {}),
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on("error", (err) => {
      console.error(`[HTTP Download] Stream error for ${filePath}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.on("close", () => {
      console.log(`[HTTP Download] Complete ${fileName}`);
    });
    return;
  }

  // GET /tts-model — serve Kokoro model components individually
  // ?model=kokoro-en-v0_19|kokoro-multi-lang-v1_0 — which model dir (default: kokoro-en-v0_19)
  // ?file=model.onnx|voices.bin|tokens.txt|espeak-ng-data — which file to serve
  if (req.method === "GET" && req.url?.startsWith("/tts-model")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    // Whitelist of allowed model directories
    const allowedModels = ["kokoro-en-v0_19", "kokoro-multi-lang-v1_0"];
    const modelName = url.searchParams.get("model") || "kokoro-en-v0_19";
    if (!allowedModels.includes(modelName)) {
      res.writeHead(400);
      res.end(`Invalid model: ${modelName}. Allowed: ${allowedModels.join(", ")}`);
      return;
    }
    const modelDir = socketAgentDataPath("tts-models", modelName);

    const fileName = url.searchParams.get("file") || "";
    if (!fileName) {
      res.writeHead(400);
      res.end("Missing ?file= parameter.");
      return;
    }

    // Directories served as tar.gz (espeak-ng-data, dict)
    const tarDirs = ["espeak-ng-data", "dict"];
    if (tarDirs.includes(fileName)) {
      const dirPath = path.join(modelDir, fileName);
      if (!fs.existsSync(dirPath)) {
        res.writeHead(404);
        res.end(`${fileName} not found`);
        return;
      }
      console.log(`[TTS Model] Serving ${modelName}/${fileName} as tar.gz...`);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename=${fileName}.tar.gz`,
        "Transfer-Encoding": "chunked",
      });
      const { spawn } = require("child_process");
      const tar = spawn("tar", ["czf", "-", "-C", modelDir, fileName]);
      tar.stdout.pipe(res);
      tar.stderr.on("data", (d: Buffer) => console.error("[TTS Model tar]", d.toString()));
      tar.on("close", (code: number) => {
        if (code !== 0) console.error(`[TTS Model] tar exited with code ${code}`);
        else console.log(`[TTS Model] ${fileName} transfer complete`);
      });
      return;
    }

    // Validate file name (only allow known files to prevent path traversal)
    const allowedFiles = ["model.onnx", "voices.bin", "tokens.txt",
      "lexicon-us-en.txt", "lexicon-gb-en.txt", "lexicon-zh.txt"];
    if (!allowedFiles.includes(fileName)) {
      res.writeHead(400);
      res.end(`Invalid file: ${fileName}. Allowed: ${allowedFiles.join(", ")}, ${tarDirs.join(", ")}`);
      return;
    }

    const filePath = path.join(modelDir, fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end(`File not found: ${fileName}`);
      return;
    }

    const stat = fs.statSync(filePath);
    console.log(`[TTS Model] Serving ${fileName} (${(stat.size / 1024 / 1024).toFixed(0)} MB)...`);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size.toString(),
      "Content-Disposition": `attachment; filename=${fileName}`,
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on("error", (err) => {
      console.error("[TTS Model] Stream error:", err);
      res.end();
    });
    return;
  }

  // GET /skills — list all skills/commands across user, project, and plugin scopes
  if (req.method === "GET" && req.url?.startsWith("/skills")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    // Use the CWD of the first active session for project-level scanning
    let projectCwd: string | undefined;
    for (const [, session] of activeSessions) {
      const cwd = session.getCwd?.();
      if (cwd) { projectCwd = cwd; break; }
    }
    if (!projectCwd) projectCwd = getDefaultCwd();
    const skills = listSkills(projectCwd);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills, projectCwd, codexSlashCommands: CODEX_NATIVE_SLASH_COMMANDS }));
    return;
  }

  // PUT /skills — create or update a skill/command
  if (req.method === "PUT" && req.url?.startsWith("/skills")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!data.name || !data.format || !data.scope) {
          res.writeHead(400);
          res.end("Missing required fields: name, format, scope");
          return;
        }
        let projectCwd: string | undefined;
        for (const [, session] of activeSessions) {
          const cwd = session.getCwd?.();
          if (cwd) { projectCwd = cwd; break; }
        }
        if (!projectCwd) projectCwd = getDefaultCwd();
        const savedPath = saveSkill({
          filePath: data.filePath || undefined,
          name: data.name,
          scope: data.scope,
          format: data.format,
          agent: data.agent === "codex" ? "codex" : "claude",
          frontmatter: data.frontmatter || {},
          body: data.body || "",
          projectCwd,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, filePath: savedPath }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(err.message || "Server error");
      }
    });
    return;
  }

  // DELETE /skills — delete a skill/command by file path
  if (req.method === "DELETE" && req.url?.startsWith("/skills")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!data.filePath) {
          res.writeHead(400);
          res.end("Missing filePath");
          return;
        }
        // Safety: only allow deleting files under ~/.claude, ~/.codex, or project agent dirs
        const home = require("os").homedir();
        const normalized = require("path").resolve(data.filePath);
        const isUserScope =
          normalized.startsWith(require("path").join(home, ".claude")) ||
          normalized.startsWith(require("path").join(home, ".codex"));
        let isProjectScope = false;
        let projectCwd: string | undefined;
        for (const [, session] of activeSessions) {
          const cwd = session.getCwd?.();
          if (cwd) { projectCwd = cwd; break; }
        }
        if (projectCwd) {
          isProjectScope =
            normalized.startsWith(require("path").join(projectCwd, ".claude")) ||
            normalized.startsWith(require("path").join(projectCwd, ".codex"));
        }
        if (!isUserScope && !isProjectScope) {
          res.writeHead(403);
          res.end("Cannot delete files outside .claude/.codex directories");
          return;
        }
        const ok = deleteSkill(normalized);
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(err.message || "Server error");
      }
    });
    return;
  }

  for (const plugin of plugins) {
    if (plugin.httpHandler && plugin.httpHandler(req, res)) return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

function getBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Handle WebSocket upgrade with auth
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `ws://localhost:${PORT}`);
  const token = getBearerToken(req) || url.searchParams.get("token");
  if (token !== AUTH_TOKEN) {
    console.log("Rejected connection: invalid token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Relay client (initialized after server starts if RELAY_URL is set)
let relayClient: RelayClient | null = null;
let relayConnectionHandler: ReturnType<typeof createConnectionHandler> | null = null;
let relayMessageQueue = Promise.resolve();

httpServer.listen(PORT, BIND_HOST, async () => {
  console.log(`Server listening on ${BIND_HOST}:${PORT} (WebSocket + HTTP)`);
  if (!["127.0.0.1", "::1", "localhost"].includes(BIND_HOST)) {
    console.warn(`[Security] Direct HTTP/WebSocket server is bound to ${BIND_HOST}. Use relay mode or TLS for untrusted networks.`);
  }
  console.log(`Default working directory: ${getDefaultCwd()}`);
  console.log(`Supported backends: ${detectAvailableBackends().join(", ")}`);

  // Initialize plugins
  const pluginContext: PluginContext = {
    getActiveSessions: () => activeSessions,
    getConnectedClients: () => connectedClients,
    broadcast: (msg: string) => {
      for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
      if (relayConnectionHandler) {
        relayConnectionHandler.sendRaw(msg);
      }
    },
    getPort: () => PORT,
    getDefaultCwd: () => getDefaultCwd(),
  };
  for (const plugin of plugins) {
    if (plugin.init) {
      try {
        await plugin.init(pluginContext);
      } catch (e: any) {
        console.error(`Plugin ${plugin.name} init failed: ${e.message}`);
      }
    }
  }

  // Start relay client if configured
  if (RELAY_URL) {
    try {
      startRelayClient();
    } catch (e: any) {
      console.error(`[Relay] Failed to start relay client: ${e?.message || String(e)}`);
    }
  }
});

// Clean up any tool calls left pending from a previous server crash
cleanupPendingToolCalls();

if (process.env.SOCKETAGENT_HISTORY_COMPACT_ON_STARTUP !== "0") {
  const runStartupHistoryCompaction = () => {
    const hasRunningSession = [...activeSessions.values()].some((session) => session.isRunning);
    if (hasRunningSession) {
      setTimeout(runStartupHistoryCompaction, 30_000).unref();
      return;
    }
    try {
      const result = compactHistoryStorage();
      if (result.scanned > 0) {
        console.log(
          `[HistoryCompact] scanned=${result.scanned} compacted=${result.compacted} ` +
          `before=${(result.beforeBytes / 1024 / 1024).toFixed(1)}MB ` +
          `after=${(result.afterBytes / 1024 / 1024).toFixed(1)}MB warnings=${result.warnings.length}`,
        );
      }
    } catch (err: any) {
      console.warn(`[HistoryCompact] startup compaction failed: ${err?.message || String(err)}`);
    }
  };
  setTimeout(runStartupHistoryCompaction, 15_000).unref();
}


// ── Periodic status sync heartbeat ──
// Broadcasts current state to all connected clients so the app stays in sync
// after reconnects, server restarts, or dropped messages.
const SERVER_STARTED_AT = new Date().toISOString();
// Cache git version at startup for status_sync
let SERVER_GIT_HASH = "";
try {
  const { execSync } = require("child_process");
  const gitRoot = findGitRoot(path.resolve(__dirname, ".."));
  if (gitRoot) SERVER_GIT_HASH = execSync("git rev-parse --short HEAD", { cwd: gitRoot, stdio: "pipe" }).toString().trim();
} catch {}
const STATUS_SYNC_IDLE_INTERVAL = 10000; // 10s when idle
const STATUS_SYNC_RUNNING_INTERVAL = 3000; // 3s when running

/** Build and broadcast status_sync to all connected clients (and relay). */
function broadcastStatusSync(): void {
  if (connectedClients.size === 0 && !relayConnectionHandler) return;

  const msg = buildStatusSyncMessage();
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
  if (relayConnectionHandler) {
    relayConnectionHandler.sendRaw(msg);
  }
}

/** Send status_sync to a single client. */
function sendStatusSyncTo(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buildStatusSyncMessage());
  }
}

function buildStatusSyncMessage(): string {
  let anyRunning = false;
  const runningSessions: string[] = [];
  const notificationSuppressedSessions: string[] = [];
  const compactingSessions: string[] = [];
  const sessionActiveStartedAt: Record<string, string> = {};
  const sessionTitles: Record<string, string> = {};
  const backgroundTaskIds: string[] = [];
  const sessionModels: Record<string, string> = {};
  for (const [sid, session] of activeSessions) {
    const busy = sessionIsBusy(session);
    if (busy) {
      anyRunning = true;
    }
    if (busy) {
      runningSessions.push(sid);
      sessionTitles[sid] = sessionNotificationTitle(sid, session);
      if (sessionSuppressesOngoingNotification(session)) {
        notificationSuppressedSessions.push(sid);
      }
      const activeStartedAt = getSessionActiveStartedAt(session);
      if (activeStartedAt) {
        sessionActiveStartedAt[sid] = activeStartedAt;
      }
    }
    if (session.isCompacting) {
      compactingSessions.push(sid);
    }
    for (const [taskId] of session.activeBackgroundTasks) {
      backgroundTaskIds.push(taskId);
    }
    if (session.sessionModel) {
      sessionModels[sid] = session.sessionModel;
    }
  }
  for (const sid of getExternalNativeRunningSessions()) {
    if (!runningSessions.includes(sid)) {
      runningSessions.push(sid);
    }
    if (!sessionTitles[sid]) {
      const title = storedSessionNotificationTitle(sid);
      if (title) sessionTitles[sid] = title;
    }
    anyRunning = true;
  }
  return JSON.stringify({
    type: "status_sync",
    running: anyRunning || compactingSessions.length > 0,
    runningSessions,
    notificationSuppressedSessions,
    compactingSessions,
    serverStartedAt: SERVER_STARTED_AT,
    serverPid: process.pid,
    serverVersion: SERVER_GIT_HASH || undefined,
    backgroundTaskIds,
    ...(Object.keys(sessionActiveStartedAt).length > 0 ? { sessionActiveStartedAt } : {}),
    ...(Object.keys(sessionTitles).length > 0 ? { sessionTitles } : {}),
    ...(Object.keys(sessionModels).length > 0 ? { sessionModels } : {}),
    plugins: plugins.map(p => p.name),
  });
}

// Adaptive heartbeat: 3s when any session is running, 10s when idle
let statusSyncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleStatusSync(): void {
  if (statusSyncTimer) clearTimeout(statusSyncTimer);

  let anyRunning = false;
  for (const [, session] of activeSessions) {
    if (sessionIsBusy(session)) { anyRunning = true; break; }
  }
  anyRunning = anyRunning || hasExternalNativeActivity();

  const interval = anyRunning ? STATUS_SYNC_RUNNING_INTERVAL : STATUS_SYNC_IDLE_INTERVAL;
  statusSyncTimer = setTimeout(() => {
    broadcastStatusSync();
    scheduleStatusSync(); // reschedule
  }, interval);
}
scheduleStatusSync();

// ── Scheduled task executor ──
const SCHEDULER_INTERVAL = 30000; // 30s

function scheduledTaskPrompt(task: ScheduledTask): string {
  if (task.notificationMode !== "quiet") return task.prompt;
  return [
    "<socketagent_scheduled_task>",
    "This scheduled task is running in quiet mode.",
    "The user will not automatically be notified on their device when you send a message or complete the task.",
    "If the user should be alerted because something is wrong, important, or requires attention, call NotifyUser with a concise title and body.",
    "Otherwise, follow the users instructions as you normally would, they can see the full session if they open it or click the notification.",
    "</socketagent_scheduled_task>",
    "",
    task.prompt,
  ].join("\n");
}

function applyLatestScheduledTaskEditableFields(task: ScheduledTask): void {
  const latest = getScheduledTask(task.id);
  if (!latest || latest.status !== "running") return;
  task.prompt = latest.prompt;
  task.cwd = latest.cwd;
  task.backend = latest.backend;
  task.codexDriver = latest.codexDriver;
  task.recurrence = latest.recurrence;
  task.reuseSession = latest.reuseSession;
  task.notificationMode = latest.notificationMode;
}

function finishManualScheduledTask(task: ScheduledTask, originalStatus: ScheduledTask["status"], success: boolean): void {
  if (originalStatus === "pending") {
    task.status = "pending";
    if (success) task.error = undefined;
    return;
  }
  task.status = success ? "completed" : "failed";
}

async function executeScheduledTask(task: ScheduledTask, trigger: "scheduled" | "manual" = "scheduled"): Promise<void> {
  if (task.status === "running") return;

  const manualRun = trigger === "manual";
  const originalStatus = task.status;
  task.status = "running";
  saveScheduledTask(task);
  broadcastScheduledTaskList();

  const runNumber = (task.runCount || 0) + 1;
  console.log(`[Scheduler] Executing ${trigger} task ${task.id} (run #${runNumber}): ${task.prompt.slice(0, 80)}`);

  try {
    if (!fs.existsSync(task.cwd)) {
      task.error = `Directory not found: ${task.cwd}`;
      if (manualRun) finishManualScheduledTask(task, originalStatus, false);
      else task.status = "failed";
      saveScheduledTask(task);
      broadcastScheduledTaskList();
      if (task.notificationMode !== "quiet") {
        broadcastScheduledTaskNotification("Scheduled task failed", task.error, "", "failed");
      }
      return;
    }

    const shouldResume = task.reuseSession && task.sessionId;
    const reusableSessionInfo = shouldResume && task.sessionId ? getSession(task.sessionId) : undefined;
    const backend = task.backend
      || reusableSessionInfo?.backend
      || "claude";
    task.backend = backend;
    const codexDriver: CodexDriver | undefined = backend === "codex" ? "app-server" : undefined;
    if (codexDriver) task.codexDriver = codexDriver;
    else task.codexDriver = undefined;
    saveScheduledTask(task);

    let session: Session;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (data: string) => forwardHeadlessScheduledAgentMessage(data, session?.getSessionId() || task.sessionId || ""),
    } as any;
    session = createSession(backend, ws, task.cwd, plugins, codexDriver);
    (session as any)._suppressOngoingNotification = task.notificationMode === "quiet";
    await restorePersistedPermissionMode(session, reusableSessionInfo || undefined);
    attachSessionLifecycleCallbacks(session);

    if (shouldResume) {
      (session as any)._resumeSessionId = task.sessionId;
      console.log(`[Scheduler] Reusing ${backend} session ${task.sessionId}`);
    }

    const tempId = `scheduled-${task.id}`;
    activeSessions.set(tempId, session);
    let scheduledStartPushSent = false;
    const maybeSendScheduledStartPush = () => {
      if (task.notificationMode === "quiet") return;
      if (scheduledStartPushSent) return;
      const sid = session.getSessionId();
      if (!sid || sid === tempId) return;
      scheduledStartPushSent = sendSessionStartedPush(session);
    };

    const currentRun: import("./scheduled-task-store").TaskRun = {
      sessionId: "",
      ...(codexDriver ? { codexDriver } : {}),
      startedAt: new Date().toISOString(),
      status: "running",
    };

    const registerInterval = setInterval(() => {
      const sid = session.getSessionId();
      if (sid && sid !== tempId) {
        clearInterval(registerInterval);
        activeSessions.delete(tempId);
        activeSessions.set(sid, session);
        task.sessionId = sid;
        currentRun.sessionId = sid;
        saveScheduledTask(task);
        maybeSendScheduledStartPush();
        broadcastSessionList();
      }
    }, 500);
    setTimeout(() => clearInterval(registerInterval), 30000);

    const resumeId = shouldResume ? task.sessionId : undefined;

    session.runQuery(scheduledTaskPrompt(task), resumeId).then(() => {
      clearInterval(registerInterval);
      const sid = session.getSessionId() || tempId;
      task.sessionId = sid;
      currentRun.sessionId = sid;
      currentRun.completedAt = new Date().toISOString();
      currentRun.status = "completed";
      currentRun.resultSummary = (session as any)._lastPreview || "Task completed";

      task.resultSummary = currentRun.resultSummary;
      task.runCount = runNumber;
      task.lastRunAt = new Date().toISOString();
      if (!task.runs) task.runs = [];
      task.runs.push(currentRun);
      applyLatestScheduledTaskEditableFields(task);

      if ((session as any).isWarmIdle) {
        void (session as any).closeWarmIdle?.();
      }
      if (activeSessions.get(sid) === session) activeSessions.delete(sid);
      if (activeSessions.get(tempId) === session) activeSessions.delete(tempId);

      const runIsRecurring = !manualRun && task.recurrence && task.recurrence.type !== "once";
      if (manualRun) {
        finishManualScheduledTask(task, originalStatus, true);
      } else if (runIsRecurring) {
        const nextTime = getNextRunTime(task);
        if (nextTime) {
          task.status = "pending";
          task.scheduledTime = nextTime;
          task.error = undefined;
          console.log(`[Scheduler] Task ${task.id} next run at ${nextTime}`);
        } else {
          task.status = "completed";
        }
      } else {
        task.status = "completed";
      }
      saveScheduledTask(task);

      broadcastScheduledTaskList();
      broadcastSessionList();
      if (task.notificationMode !== "quiet") {
        const title = manualRun
          ? "Scheduled task run complete"
          : runIsRecurring ? `Recurring task complete (run #${runNumber})` : "Scheduled task complete";
        const body = task.resultSummary || task.prompt;
        const hasRealSessionId = Boolean(session.getSessionId());
        if (hasRealSessionId) {
          sendSessionCompletionPush(session, "completed", body);
        }
        broadcastScheduledTaskNotification(
          title,
          body,
          task.sessionId || "",
          "completed",
          hasRealSessionId ? { sendPush: false } : {},
        );
      }
      console.log(`[Scheduler] Task ${task.id} run #${runNumber} completed, session ${sid}`);
    }).catch((err) => {
      clearInterval(registerInterval);
      const sid = session.getSessionId() || tempId;
      task.sessionId = sid !== tempId ? sid : undefined;
      currentRun.sessionId = sid !== tempId ? sid : "";
      currentRun.completedAt = new Date().toISOString();
      currentRun.status = "failed";
      currentRun.error = err.message || "Unknown error";

      task.error = currentRun.error;
      task.runCount = runNumber;
      task.lastRunAt = new Date().toISOString();
      if (!task.runs) task.runs = [];
      task.runs.push(currentRun);
      applyLatestScheduledTaskEditableFields(task);

      if ((session as any).isWarmIdle) {
        void (session as any).closeWarmIdle?.();
      }
      activeSessions.delete(tempId);
      if (sid !== tempId) activeSessions.delete(sid);

      const runIsRecurring = !manualRun && task.recurrence && task.recurrence.type !== "once";
      if (manualRun) {
        finishManualScheduledTask(task, originalStatus, false);
      } else if (runIsRecurring) {
        const nextTime = getNextRunTime(task);
        if (nextTime) {
          task.status = "pending";
          task.scheduledTime = nextTime;
          console.log(`[Scheduler] Task ${task.id} failed but rescheduled for ${nextTime}`);
        } else {
          task.status = "failed";
        }
      } else {
        task.status = "failed";
      }
      saveScheduledTask(task);

      broadcastScheduledTaskList();
      if (task.notificationMode !== "quiet") {
        const title = manualRun
          ? "Scheduled task run failed"
          : runIsRecurring ? `Recurring task failed (run #${runNumber})` : "Scheduled task failed";
        const body = currentRun.error || task.prompt;
        if (session.getSessionId()) {
          sendSessionCompletionPush(session, "failed", body);
        }
        broadcastScheduledTaskNotification(
          title,
          body,
          task.sessionId || "",
          "failed",
          session.getSessionId() ? { sendPush: false } : {},
        );
      }
      console.error(`[Scheduler] Task ${task.id} run #${runNumber} failed: ${err.message}`);
    });
  } catch (err: any) {
    task.error = err.message;
    if (manualRun) finishManualScheduledTask(task, originalStatus, false);
    else task.status = "failed";
    saveScheduledTask(task);
    broadcastScheduledTaskList();
    if (task.notificationMode !== "quiet") {
      broadcastScheduledTaskNotification("Scheduled task failed", task.error!, "", "failed");
    }
  }
}

async function checkScheduledTasks(): Promise<void> {
  const dueTasks = getDueTasks();
  for (const task of dueTasks) {
    executeScheduledTask(task).catch((err: any) => {
      console.error(`[Scheduler] Task ${task.id} failed before launch: ${err?.message || err}`);
    });
  }
}

setInterval(checkScheduledTasks, SCHEDULER_INTERVAL);
// Also run once on startup to catch overdue tasks
setTimeout(checkScheduledTasks, 5000);

// ── Direct WebSocket connections ──
wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected (authenticated)");
  connectedClients.add(ws);

  // Send immediate status so the app knows server state right away
  sendStatusSyncTo(ws);

  const handler = createConnectionHandler(ws);
  let messageQueue = Promise.resolve();

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    let msg: ClientMessage;

    console.log(`[WS Recv] isBinary=${isBinary} bytes=${data.length}`);
    if (isBinary) {
      // Direct-WS binary frame — currently only used for upload chunks.
      // Format: [1 marker(0x42)][1 idLen][idBytes][4 chunkIdx BE][bytes]
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length < 6 || buf[0] !== 0x42) {
        ws.send(JSON.stringify({ type: "error", message: "Unknown binary frame" }));
        return;
      }
      const idLen = buf[1];
      const headerEnd = 2 + idLen + 4;
      if (buf.length < headerEnd) {
        ws.send(JSON.stringify({ type: "error", message: "Binary frame too short" }));
        return;
      }
      const uploadId = buf.subarray(2, 2 + idLen).toString("utf-8");
      const off = 2 + idLen;
      const chunkIndex = buf.readUInt32BE(off);
      const chunkBytes = buf.subarray(headerEnd);
      msg = { type: "upload_chunk_bin", uploadId, chunkIndex, data: chunkBytes } as any;
    } else {
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }
    }

    const receivedAt = Date.now();
    const msgType = (msg as any)?.type || "unknown";
    messageQueue = messageQueue
      .then(async () => {
        const startedAt = Date.now();
        logSlowWs("ws_queue_wait", receivedAt, { type: msgType });
        try {
          await handler.handleMessage(msg);
        } finally {
          logSlowWs("ws_handler", startedAt, { type: msgType });
        }
      })
      .catch((err: any) => {
        ws.send(
          JSON.stringify({
            type: "error",
            message: err.message || "Server error",
          })
        );
      });
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    handler.close();
    connectedClients.delete(ws);
    // Clean up session client mapping for this connection
    if (handler.activeSessionId) {
      const client = sessionClients.get(handler.activeSessionId);
      if (client && client.ws === ws) {
        sessionClients.delete(handler.activeSessionId);
      }
    }
    // DON'T abort — let the session keep running in the background
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ── Relay client setup ──
function redactSecretForLog(secret: string): string {
  if (!secret) return "<empty>";
  if (secret.length <= 12) return "<redacted>";
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

function startRelayClient(): void {
  const keysPath = socketAgentDataPath("relay-keys.json");
  const keyPair = loadOrCreateKeyPair(keysPath);
  const pubkeyBase64 = toBase64(keyPair.publicKey);

  console.log(`[Relay] Connecting to ${RELAY_URL}`);
  console.log(`[Relay] Pairing token: ${redactSecretForLog(PAIRING_TOKEN)}`);

  // Display QR code for pairing. The SC prefix is kept as the wire-format
  // marker so existing SocketClaude app builds can still re-pair.
  const qrPayload = `SC|${PAIRING_TOKEN}|${pubkeyBase64}`;

  if (process.env.SOCKETAGENT_SHOW_PAIRING_QR_ON_STARTUP === "1") {
    try {
      const qrcode = require("qrcode-terminal");
      console.log(`\n[Relay] Scan this QR code with SocketAgent app to pair:\n`);
      qrcode.generate(qrPayload, { small: true }, (qr: string) => {
        console.log(qr);
      });
    } catch {
      console.log(`[Relay] QR payload (paste into app): ${qrPayload}`);
    }
  } else {
    console.log("[Relay] Pairing QR suppressed in logs. Set SOCKETAGENT_SHOW_PAIRING_QR_ON_STARTUP=1 for an explicit pairing session.");
  }

  relayClient = new RelayClient({
    relayUrl: RELAY_URL,
    pairingToken: PAIRING_TOKEN,
    keyPair,
    onMessage: (msg: ClientMessage) => {
      if (!relayConnectionHandler) {
        // Create handler on first message (phone just paired)
        relayConnectionHandler = createConnectionHandler(relayClient!.getVirtualSocket() as any);
        console.log(`[Relay] Created connection handler for phone`);
      }
      const handler = relayConnectionHandler;
      const receivedAt = Date.now();
      const msgType = (msg as any)?.type || "unknown";
      relayMessageQueue = relayMessageQueue
        .then(async () => {
          const startedAt = Date.now();
          logSlowWs("relay_queue_wait", receivedAt, { type: msgType });
          try {
            await handler.handleMessage(msg);
          } finally {
            logSlowWs("relay_handler", startedAt, { type: msgType });
          }
        })
        .catch((err: any) => {
          console.error(`[Relay] Message handler error: ${err.message}`);
          handler.sendJson({
            type: "error",
            message: err.message || "Server error",
          });
        });
    },
    onStatusChange: (status: RelayStatus) => {
      console.log(`[Relay] Status: ${status}`);
      if (status === "paired") {
        // Reset handler when phone reconnects so it gets a fresh state
        relayConnectionHandler?.close();
        relayConnectionHandler = createConnectionHandler(relayClient!.getVirtualSocket() as any);
        relayMessageQueue = Promise.resolve();
        console.log(`[Relay] Phone paired — ready for messages`);
      }
      if (status === "waiting_for_peer" || status === "disconnected") {
        relayConnectionHandler?.close();
        relayConnectionHandler = null;
        relayMessageQueue = Promise.resolve();
      }
    },
  });

  relayClient.connect();
}

// ── Auto-update from git ──
const AUTO_UPDATE_INTERVAL = 60000; // Check every 60s
const SERVER_DIR = path.resolve(__dirname, ".."); // server/ directory

function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const GIT_ROOT: string = (() => {
  const root = findGitRoot(SERVER_DIR);
  if (!root) {
    console.error("[Startup] SocketAgent server must run from a git checkout. Zip/archive or copied installs are not supported.");
    console.error("[Startup] Install with: git clone https://github.com/Yllib/socketagent.git");
    process.exit(1);
  }
  return root;
})();
let lastAutoUpdateError: string | null = null;
let autoUpdateInProgress = false;

const NODE_MIN_VERSION = parseInt(process.env.SOCKETAGENT_NODE_MIN_VERSION || "22", 10);
const NODE_RUNTIME_VERSION = process.env.SOCKETAGENT_NODE_VERSION || "22.22.1";

interface UpdateRuntimeTools {
  env: NodeJS.ProcessEnv;
  npm: string;
  npx: string;
}

function nodeCommandName(base: string): string {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function defaultManagedNodeDir(): string {
  const home = process.env.HOME || os.homedir();
  return process.env.SOCKETAGENT_NODE_DIR || path.join(home, ".local", "share", "socketagent", "node");
}

function defaultManagedNodePath(): string {
  return process.platform === "win32"
    ? path.join(defaultManagedNodeDir(), "node.exe")
    : path.join(defaultManagedNodeDir(), "bin", "node");
}

function nodeMajorVersion(nodePath: string): number | null {
  try {
    const raw = execFileSync(nodePath, ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const major = parseInt(raw.replace(/^v/, "").split(".")[0] || "", 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

function nodeIsUsable(nodePath: string | undefined): nodePath is string {
  if (!nodePath) return false;
  try {
    if (!fs.existsSync(nodePath)) return false;
    const major = nodeMajorVersion(nodePath);
    return major !== null && major >= NODE_MIN_VERSION;
  } catch {
    return false;
  }
}

function installManagedNodeRuntime(): void {
  if (process.platform === "win32") {
    throw new Error("Managed Node auto-install is only supported on Linux; install Node.js 22+ manually on Windows");
  }

  const arch = os.arch();
  const nodeArch = arch === "x64"
    ? "x64"
    : arch === "arm64"
      ? "arm64"
      : arch === "arm"
        ? "armv7l"
        : "";
  if (!nodeArch) throw new Error(`Unsupported architecture for managed Node.js: ${arch}`);

  const nodeDir = defaultManagedNodeDir();
  const tarball = `node-v${NODE_RUNTIME_VERSION}-linux-${nodeArch}.tar.xz`;
  const url = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${tarball}`;
  const tmp = path.join(os.tmpdir(), `${tarball}.${process.pid}`);

  console.log(`[UpdateRuntime] Installing managed Node.js v${NODE_RUNTIME_VERSION} to ${nodeDir}`);
  execFileSync("curl", ["-fSL", "--retry", "3", "--connect-timeout", "15", "-o", tmp, url], { stdio: "pipe", timeout: 120000 });
  fs.rmSync(nodeDir, { recursive: true, force: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  execFileSync("tar", ["-xJf", tmp, "-C", nodeDir, "--strip-components=1"], { stdio: "pipe", timeout: 120000 });
  fs.rmSync(tmp, { force: true });

  if (!nodeIsUsable(defaultManagedNodePath())) {
    throw new Error(`Managed Node.js install did not produce a usable Node ${NODE_MIN_VERSION}+ runtime`);
  }
}

function resolveUpdateRuntimeTools(): UpdateRuntimeTools {
  let nodePath = [
    process.env.SOCKETAGENT_NODE,
    defaultManagedNodePath(),
    process.execPath,
  ].find(nodeIsUsable);

  if (!nodePath && process.platform !== "win32") {
    installManagedNodeRuntime();
    nodePath = defaultManagedNodePath();
  }

  if (!nodePath) {
    const currentMajor = nodeMajorVersion(process.execPath);
    console.warn(`[UpdateRuntime] Node.js ${currentMajor || "unknown"} is older than v${NODE_MIN_VERSION}; falling back to PATH npm/npx`);
    return {
      env: { ...process.env },
      npm: nodeCommandName("npm"),
      npx: nodeCommandName("npx"),
    };
  }

  const nodeDir = path.dirname(nodePath);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = env[pathKey] ? `${nodeDir}${path.delimiter}${env[pathKey]}` : nodeDir;
  env.PATH = env[pathKey];
  env.SOCKETAGENT_NODE = nodePath;
  env.SOCKETAGENT_NPM = process.platform === "win32"
    ? path.join(nodeDir, "npm.cmd")
    : path.join(nodeDir, "npm");
  env.SOCKETAGENT_NPX = process.platform === "win32"
    ? path.join(nodeDir, "npx.cmd")
    : path.join(nodeDir, "npx");

  console.log(`[UpdateRuntime] Using Node.js ${execFileSync(nodePath, ["--version"], { encoding: "utf-8" }).trim()} at ${nodePath}`);
  return {
    env,
    npm: env.SOCKETAGENT_NPM,
    npx: env.SOCKETAGENT_NPX,
  };
}

function quoteWindowsCmdArg(value: string): string {
  if (!/[ \t&()^|<>"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function updateToolCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  const commandLine = [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `"${commandLine}"`,
    ],
  };
}

function runPackageUpdateSync(cwd: string): void {
  const runtime = resolveUpdateRuntimeTools();
  const npm = updateToolCommand(runtime.npm, ["ci", "--include=optional"]);
  execFileSync(npm.command, npm.args, {
    cwd,
    env: runtime.env,
    stdio: "pipe",
    timeout: 120000,
  });
  const npx = updateToolCommand(runtime.npx, ["tsc"]);
  execFileSync(npx.command, npx.args, {
    cwd,
    env: runtime.env,
    stdio: "pipe",
    timeout: 120000,
  });
}

function runUpdateToolAsync(runtime: UpdateRuntimeTools, command: string, args: string[], cwd: string): Promise<string> {
  const { execFile } = require("child_process");
  const spec = updateToolCommand(command, args);
  return new Promise((resolve, reject) => {
    execFile(spec.command, spec.args, {
      cwd,
      env: runtime.env,
      timeout: 120000,
    }, (err: any, stdout: any, stderr: any) => {
      if (err) {
        err.message = stderr ? `${err.message}\n${stderr}` : err.message;
        reject(err);
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

async function runPackageUpdate(cwd: string): Promise<void> {
  const runtime = resolveUpdateRuntimeTools();
  await runUpdateToolAsync(runtime, runtime.npm, ["ci", "--include=optional"], cwd);
  await runUpdateToolAsync(runtime, runtime.npx, ["tsc"], cwd);
}

function pathIncludesDir(pathValue: string | undefined, dir: string): boolean {
  if (!pathValue) return false;
  const entries = pathValue.split(path.delimiter).map((entry) => path.resolve(entry || "."));
  return entries.includes(path.resolve(dir));
}

function appendUnixPathHint(home: string, binDir: string): void {
  if (pathIncludesDir(process.env.PATH, binDir)) return;

  const shellFiles = [".profile", ".bashrc", ".zshrc"].map((file) => path.join(home, file));
  const alreadyConfigured = shellFiles.some((file) => {
    try {
      return fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes(".local/bin");
    } catch {
      return false;
    }
  });
  if (alreadyConfigured) return;

  const profilePath = path.join(home, ".profile");
  fs.appendFileSync(
    profilePath,
    `\n# SocketAgent CLI\nexport PATH="$HOME/.local/bin:$PATH"\n`
  );
}

function replaceSymlink(linkPath: string, targetPath: string): void {
  try {
    const existing = fs.lstatSync(linkPath);
    if (!existing.isSymbolicLink() && !existing.isFile()) {
      console.warn(`[CLI] Skipping ${linkPath}; path exists and is not a file or symlink`);
      return;
    }
    fs.rmSync(linkPath, { force: true });
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  fs.symlinkSync(targetPath, linkPath);
}

function installSocketAgentCliUnix(gitRoot: string): void {
  const os = require("os");
  const home = process.env.HOME || os.homedir();
  if (!home) throw new Error("HOME is not set");

  const targetPath = path.join(gitRoot, "bin", "socketagent");
  if (!fs.existsSync(targetPath)) {
    console.warn(`[CLI] socketagent target missing: ${targetPath}`);
    return;
  }

  fs.chmodSync(targetPath, 0o755);
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  replaceSymlink(path.join(binDir, "socketagent"), targetPath);
  replaceSymlink(path.join(binDir, "socketclaude"), targetPath);
  appendUnixPathHint(home, binDir);
  console.log(`[CLI] Installed socketagent command in ${binDir}`);
}

function installSocketAgentCliWindows(gitRoot: string): void {
  const os = require("os");
  const { execFileSync } = require("child_process");
  const userHome = process.env.USERPROFILE || os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(userHome, "AppData", "Local");
  const binDir = path.join(localAppData, "SocketAgent", "bin");
  const ps1Path = path.join(gitRoot, "bin", "socketagent.ps1");
  if (!fs.existsSync(ps1Path)) {
    console.warn(`[CLI] socketagent PowerShell target missing: ${ps1Path}`);
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });
  const cmdBody = `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}" %*\r\n`;
  fs.writeFileSync(path.join(binDir, "socketagent.cmd"), cmdBody);
  fs.writeFileSync(path.join(binDir, "socketclaude.cmd"), cmdBody);

  const escapedBinDir = binDir.replace(/'/g, "''");
  const pathCommand = [
    "$path = [Environment]::GetEnvironmentVariable('PATH', 'User')",
    `$dir = '${escapedBinDir}'`,
    "if (-not (($path -split ';') -contains $dir)) {",
    "  $newPath = if ([string]::IsNullOrWhiteSpace($path)) { $dir } else { \"$path;$dir\" }",
    "  [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')",
    "}",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", pathCommand], { stdio: "pipe" });
  console.log(`[CLI] Installed socketagent command in ${binDir}`);
}

function installSocketAgentCliFromRepo(gitRoot: string): void {
  try {
    if (process.platform === "win32") {
      installSocketAgentCliWindows(gitRoot);
    } else {
      installSocketAgentCliUnix(gitRoot);
    }
  } catch (e: any) {
    console.error(`[CLI] Failed to install socketagent command: ${e?.message || String(e)}`);
  }
}

function batchSetValue(value: string | undefined): string {
  return String(value || "").replace(/"/g, "");
}

function windowsRecoveryBatContent(): string {
  const logFile = path.join(SERVER_DIR, "socketagent.log");
  return [
    "@echo off",
    "setlocal EnableExtensions",
    "rem SocketAgent Windows recovery guard",
    `set "SERVER_DIR=${batchSetValue(SERVER_DIR)}"`,
    `set "LOG_FILE=${batchSetValue(logFile)}"`,
    'set "PORT=8085"',
    'for /f "tokens=1,* delims==" %%A in (\'findstr /b "PORT=" "%SERVER_DIR%\\.env" 2^>nul\') do if /i "%%A"=="PORT" set "PORT=%%B"',
    'set "PORT=%PORT:"=%"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=[int]$env:PORT; $c=New-Object Net.Sockets.TcpClient; try { $iar=$c.BeginConnect(\'127.0.0.1\',$p,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne(1500,$false)) { exit 1 }; $c.EndConnect($iar); exit 0 } catch { exit 1 } finally { $c.Close() }"',
    "if not errorlevel 1 goto done",
    'echo [recovery] SocketAgent is not listening on port %PORT%; restarting scheduled task. >> "%LOG_FILE%" 2>&1',
    'set "TASK_NAME=SocketAgent"',
    'schtasks /Query /TN SocketAgent >nul 2>&1 || set "TASK_NAME=SocketClaude"',
    'schtasks /End /TN "%TASK_NAME%" >> "%LOG_FILE%" 2>&1',
    "timeout /t 2 /nobreak >nul",
    'schtasks /Run /TN "%TASK_NAME%" >> "%LOG_FILE%" 2>&1',
    ":done",
    "schtasks /Delete /TN SocketAgentRecovery /F >nul 2>&1",
    "exit /b 0",
    "",
  ].join("\r\n");
}

function windowsRunServiceBatContent(): string {
  const userHome = process.env.USERPROFILE || os.homedir();
  const logFile = path.join(SERVER_DIR, "socketagent.log");
  const serverScript = path.join(SERVER_DIR, "dist", "index.js");
  const nodeExe = process.env.SOCKETAGENT_NODE || process.execPath;
  const servicePath = batchSetValue(process.env.PATH);

  return [
    "@echo off",
    "setlocal EnableExtensions",
    "rem SocketAgent Windows service wrapper v2",
    `set "HOME=${batchSetValue(userHome)}"`,
    `set "PATH=${servicePath}"`,
    `set "SERVER_DIR=${batchSetValue(SERVER_DIR)}"`,
    `set "REPO_ROOT=${batchSetValue(GIT_ROOT)}"`,
    `set "LOG_FILE=${batchSetValue(logFile)}"`,
    `set "NODE_EXE=${batchSetValue(nodeExe)}"`,
    `set "SERVER_SCRIPT=${batchSetValue(serverScript)}"`,
    `set "RECOVERY_BAT=${batchSetValue(path.join(SERVER_DIR, "run-recovery.bat"))}"`,
    'set "NPM_CMD=npm.cmd"',
    'set "NPX_CMD=npx.cmd"',
    'if exist "%ProgramFiles%\\nodejs\\npm.cmd" set "NPM_CMD=%ProgramFiles%\\nodejs\\npm.cmd"',
    'if exist "%ProgramFiles%\\nodejs\\npx.cmd" set "NPX_CMD=%ProgramFiles%\\nodejs\\npx.cmd"',
    "",
    ":loop",
    "call :arm_recovery",
    'call :preflight >> "%LOG_FILE%" 2>&1',
    'if errorlevel 1 echo [startup] Preflight update failed; launching existing build. >> "%LOG_FILE%" 2>&1',
    'cd /d "%SERVER_DIR%"',
    '"%NODE_EXE%" "%SERVER_SCRIPT%" >> "%LOG_FILE%" 2>&1',
    'echo Server exited (%ERRORLEVEL%), restarting in 5s... >> "%LOG_FILE%" 2>&1',
    "timeout /t 5 /nobreak >nul",
    "goto loop",
    "",
    ":arm_recovery",
    'if not exist "%RECOVERY_BAT%" exit /b 0',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$a=New-ScheduledTaskAction -Execute $env:ComSpec -Argument (\'/d /c \' + [char]34 + $env:RECOVERY_BAT + [char]34); $t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5); Register-ScheduledTask -TaskName \'SocketAgentRecovery\' -Action $a -Trigger $t -Force | Out-Null" >nul 2>&1',
    "exit /b 0",
    "",
    ":preflight",
    'cd /d "%REPO_ROOT%"',
    "git rev-parse --is-inside-work-tree >nul 2>&1 || exit /b 0",
    "git fetch origin",
    "if errorlevel 1 exit /b 0",
    "set \"BRANCH=\"",
    "set \"LOCAL_HASH=\"",
    "set \"REMOTE_HASH=\"",
    "for /f %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set \"BRANCH=%%B\"",
    "if not defined BRANCH exit /b 0",
    "for /f %%H in ('git rev-parse HEAD 2^>nul') do set \"LOCAL_HASH=%%H\"",
    "for /f %%H in ('git rev-parse origin/%BRANCH% 2^>nul') do set \"REMOTE_HASH=%%H\"",
    "if not defined REMOTE_HASH exit /b 0",
    'if "%LOCAL_HASH%"=="%REMOTE_HASH%" exit /b 0',
    "echo [Auto-update] Applying %REMOTE_HASH:~0,7% from origin/%BRANCH%",
    "git reset --hard origin/%BRANCH%",
    "if errorlevel 1 exit /b 1",
    'cd /d "%SERVER_DIR%"',
    'call "%NPM_CMD%" ci --include=optional',
    "if errorlevel 1 exit /b 1",
    'call "%NPX_CMD%" tsc',
    "if errorlevel 1 exit /b 1",
    '> "%REPO_ROOT%\\.last-auto-update-hash" echo %REMOTE_HASH%',
    "exit /b 0",
    "",
  ].join("\r\n");
}

function ensureWindowsServiceWrapper(): void {
  if (process.platform !== "win32") return;
  try {
    const batFile = path.join(SERVER_DIR, "run-service.bat");
    const recoveryFile = path.join(SERVER_DIR, "run-recovery.bat");
    const content = windowsRunServiceBatContent();
    const recoveryContent = windowsRecoveryBatContent();
    let current = "";
    try { current = fs.readFileSync(batFile, "utf-8"); } catch {}
    if (current.replace(/\r\n/g, "\n") !== content.replace(/\r\n/g, "\n")) {
      fs.writeFileSync(batFile, content, "ascii");
      console.log(`[Startup] Updated Windows service wrapper at ${batFile}`);
    }
    let currentRecovery = "";
    try { currentRecovery = fs.readFileSync(recoveryFile, "utf-8"); } catch {}
    if (currentRecovery.replace(/\r\n/g, "\n") !== recoveryContent.replace(/\r\n/g, "\n")) {
      fs.writeFileSync(recoveryFile, recoveryContent, "ascii");
      console.log(`[Startup] Updated Windows recovery wrapper at ${recoveryFile}`);
    }
  } catch (e: any) {
    console.warn(`[Startup] Could not update Windows service wrapper: ${e?.message || String(e)}`);
  }
}

function unquoteSystemdValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function ensureStartupPreflightService(): void {
  if (process.platform === "win32") return;

  try {
    const home = process.env.HOME || os.homedir();
    if (!home) return;

    const wrapperPath = path.join(SERVER_DIR, "scripts", "start-server.sh");
    if (!fs.existsSync(wrapperPath)) return;
    fs.chmodSync(wrapperPath, 0o755);

    const serviceDir = path.join(home, ".config", "systemd", "user");
    const serviceFiles = ["socketagent.service", "socketclaude.service"]
      .map((name) => path.join(serviceDir, name))
      .filter((file) => fs.existsSync(file));

    let changed = false;
    const expectedDist = path.join(SERVER_DIR, "dist", "index.js");

    for (const serviceFile of serviceFiles) {
      const body = fs.readFileSync(serviceFile, "utf-8");
      const execMatch = body.match(/^ExecStart=(.*)$/m);
      if (!execMatch) continue;

      const execStart = unquoteSystemdValue(execMatch[1]);
      if (execStart === wrapperPath) continue;
      if (!execStart.includes("dist/index.js") && !execStart.includes(expectedDist)) continue;

      const workingDirMatch = body.match(/^WorkingDirectory=(.*)$/m);
      const workingDir = workingDirMatch ? unquoteSystemdValue(workingDirMatch[1]) : "";
      const ownsUnit = workingDir ? path.resolve(workingDir) === SERVER_DIR : execStart.includes(expectedDist);
      if (!ownsUnit) continue;

      const updated = body.replace(/^ExecStart=.*$/m, `ExecStart=${wrapperPath}`);
      fs.writeFileSync(serviceFile, updated);
      changed = true;
      console.log(`[Startup] Updated ${path.basename(serviceFile)} to use startup self-repair wrapper`);
    }

    if (changed) {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    }
  } catch (e: any) {
    console.warn(`[Startup] Could not update systemd service wrapper: ${e?.message || String(e)}`);
  }
}

function armUnixRecoveryGuard(reason: string, delaySeconds = 180): string | null {
  if (process.platform === "win32") return null;
  const script = path.join(SERVER_DIR, "scripts", "recovery-guard.sh");
  if (!fs.existsSync(script)) {
    throw new Error(`Recovery guard script is missing: ${script}`);
  }
  fs.chmodSync(script, 0o755);
  const id = execFileSync(script, ["arm", reason, String(delaySeconds)], {
    cwd: SERVER_DIR,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
  if (!id) throw new Error("Recovery guard did not return an id");
  console.log(`[Recovery] Armed ${reason} guard: ${id}`);
  return id;
}

function armWindowsRecoveryGuard(reason: string, delaySeconds = 300): string | null {
  if (process.platform !== "win32") return null;
  ensureWindowsServiceWrapper();
  const recoveryFile = path.join(SERVER_DIR, "run-recovery.bat");
  if (!fs.existsSync(recoveryFile)) {
    throw new Error(`Windows recovery script is missing: ${recoveryFile}`);
  }
  const command = [
    "$bat = $env:SOCKETAGENT_RECOVERY_BAT",
    "$delay = [int]$env:SOCKETAGENT_RECOVERY_DELAY_SECONDS",
    "$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/d /c ' + [char]34 + $bat + [char]34)",
    "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($delay)",
    "Register-ScheduledTask -TaskName 'SocketAgentRecovery' -Action $action -Trigger $trigger -Force | Out-Null",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SOCKETAGENT_RECOVERY_BAT: recoveryFile,
      SOCKETAGENT_RECOVERY_DELAY_SECONDS: String(delaySeconds),
    },
    stdio: "pipe",
    timeout: 10000,
  });
  console.log(`[Recovery] Armed Windows ${reason} guard via ${recoveryFile}`);
  return "SocketAgentRecovery";
}

function armRestartRecoveryGuard(reason: string, delaySeconds = 180): string | null {
  return process.platform === "win32"
    ? armWindowsRecoveryGuard(reason, Math.max(delaySeconds, 300))
    : armUnixRecoveryGuard(reason, delaySeconds);
}

async function checkForUpdates(): Promise<void> {
  if (autoUpdateInProgress) return;
  autoUpdateInProgress = true;
  try {
    const { execSync, exec } = require("child_process");
    const execAsync = (cmd: string, opts: any): Promise<string> =>
      new Promise((resolve, reject) => {
        exec(cmd, opts, (err: any, stdout: any) => err ? reject(err) : resolve(String(stdout).trim()));
      });

    // Fetch latest from origin (async to avoid blocking event loop / relay pings)
    await execAsync("git fetch origin", { cwd: GIT_ROOT, timeout: 30000 });

    // These are fast local git operations — safe to use execSync
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();

    let remote: string;
    try {
      remote = execSync(`git rev-parse origin/${branch}`, { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
    } catch {
      return; // No remote tracking branch
    }

    const local = execSync("git rev-parse HEAD", { cwd: GIT_ROOT, stdio: "pipe" }).toString().trim();
    if (process.platform === "win32") {
      if (remote === local) return;
      const blockReason = autoUpdateBlockReason();
      if (blockReason) {
        console.log(`[Auto-update] Update available (${remote.substring(0, 7)}) but ${blockReason}, deferring Windows wrapper restart...`);
        return;
      }
      console.log(`[Auto-update] Update available (${remote.substring(0, 7)}); restarting for Windows wrapper update...`);
      try {
        armRestartRecoveryGuard("windows-auto-update", 300);
      } catch (guardErr: any) {
        lastAutoUpdateError = `Recovery guard could not be armed: ${guardErr?.message || String(guardErr)}`;
        console.error(`[Auto-update] ${lastAutoUpdateError}`);
        return;
      }
      process.exit(1);
    }

    // Track the last remote hash we successfully applied to prevent restart loops
    // when servers have local commits (local HEAD != origin HEAD permanently)
    const lastAppliedFile = path.join(GIT_ROOT, ".last-auto-update-hash");
    let lastApplied = "";
    try { lastApplied = fs.readFileSync(lastAppliedFile, "utf-8").trim(); } catch {}

    if (remote === lastApplied) return; // Already applied this remote version

    const blockReason = autoUpdateBlockReason();
    if (blockReason) {
      console.log(`[Auto-update] Update available (${remote.substring(0, 7)}) but ${blockReason}, deferring...`);
      return;
    }

    console.log(`[Auto-update] Pulling to ${remote.substring(0, 7)}...`);

    // Hard reset to origin — remote servers are deployment mirrors, not dev environments
    await execAsync(`git reset --hard origin/${branch}`, { cwd: GIT_ROOT, timeout: 30000 });

    const tscDir = fs.existsSync(path.join(GIT_ROOT, "server", "tsconfig.json"))
      ? path.join(GIT_ROOT, "server")
      : GIT_ROOT;
    // Install/update deps so SDK and other package changes are picked up
    await runPackageUpdate(tscDir);
    installSocketAgentCliFromRepo(GIT_ROOT);

    lastAutoUpdateError = null;

    // Mark this remote version as applied BEFORE restarting
    fs.writeFileSync(lastAppliedFile, remote);

    console.log(`[Auto-update] Compiled successfully, restarting for ${remote.substring(0, 7)}...`);
    try {
      armRestartRecoveryGuard("auto-update", 180);
    } catch (guardErr: any) {
      lastAutoUpdateError = `Recovery guard could not be armed: ${guardErr?.message || String(guardErr)}`;
      console.error(`[Auto-update] ${lastAutoUpdateError}`);
      return;
    }

    // Exit with non-zero so systemd Restart=on-failure triggers a restart.
    // exit(0) is clean and won't restart. Windows batch loops check for any exit.
    process.exit(1);
  } catch (e: any) {
    lastAutoUpdateError = e.message;
    console.error(`[Auto-update] Error: ${e.message}`);
  } finally {
    autoUpdateInProgress = false;
  }
}

installSocketAgentCliFromRepo(GIT_ROOT);
ensureStartupPreflightService();
ensureWindowsServiceWrapper();
console.log(`[Auto-update] Watching git repo at ${GIT_ROOT} (every ${AUTO_UPDATE_INTERVAL / 1000}s)`);
setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);

// Graceful shutdown — clean up plugins, relay, and watchers
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, cleaning up...`);
    if (relayClient) relayClient.close();
    for (const plugin of plugins) {
      if (plugin.cleanup) {
        try { await plugin.cleanup(); } catch {}
      }
    }
    process.exit(0);
  });
}
