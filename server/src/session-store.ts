import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { Backend, SessionInfo, HistoryEntry } from "./protocol";
import { CodexAppServerClient, type CodexAppServerThreadListParams } from "./codex-app-server-client";
import { codexAppServerThreadToHistory, codexRolloutJsonlToHistory } from "./codex-native-history";

const STORE_DIR = path.join(
  process.env.HOME || require("os").homedir(),
  ".claude-assistant"
);
const STORE_FILE = path.join(STORE_DIR, "sessions.json");
const HISTORY_DIR = path.join(STORE_DIR, "history");

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readStore(): SessionInfo[] {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(STORE_FILE, "utf-8");
  return JSON.parse(raw) as SessionInfo[];
}

function writeStore(sessions: SessionInfo[]): void {
  ensureStoreDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(sessions, null, 2), "utf-8");
}

export function listSessions(): SessionInfo[] {
  return readStore().sort(
    (a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
  );
}

export function saveSession(session: SessionInfo): void {
  const sessions = readStore();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  writeStore(sessions);
}

export function getSession(id: string): SessionInfo | undefined {
  return readStore().find((s) => s.id === id);
}

export function deleteSession(id: string): void {
  const sessions = readStore().filter((s) => s.id !== id);
  writeStore(sessions);
}

/** Remap a session entry from oldId to newId (after context clear creates a fresh SDK session) */
export function remapSession(oldId: string, newId: string): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === oldId);
  if (session) {
    session.id = newId;
    delete (session as any).contextClearedAt;
    session.lastActive = new Date().toISOString();
    writeStore(sessions);
    console.log(`[Remap] Session ${oldId} → ${newId}`);
  }
}

// ── Recent CWDs (persisted per-server) ──

const RECENT_CWDS_FILE = path.join(STORE_DIR, "recent-cwds.json");
const MAX_RECENT_CWDS = 20;

function readRecentCwds(): string[] {
  ensureStoreDir();
  if (!fs.existsSync(RECENT_CWDS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(RECENT_CWDS_FILE, "utf-8")) as string[];
  } catch {
    return [];
  }
}

function writeRecentCwds(cwds: string[]): void {
  ensureStoreDir();
  fs.writeFileSync(RECENT_CWDS_FILE, JSON.stringify(cwds, null, 2), "utf-8");
}

export function getRecentCwds(): string[] {
  return readRecentCwds();
}

export function addRecentCwd(cwd: string): string[] {
  const cwds = readRecentCwds().filter(c => c !== cwd);
  cwds.unshift(cwd);
  if (cwds.length > MAX_RECENT_CWDS) cwds.length = MAX_RECENT_CWDS;
  writeRecentCwds(cwds);
  return cwds;
}

export function removeRecentCwd(cwd: string): string[] {
  const cwds = readRecentCwds().filter(c => c !== cwd);
  writeRecentCwds(cwds);
  return cwds;
}

export function updateSessionActivity(
  id: string,
  messagePreview: string,
  lastUsage?: any
): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === id);
  if (session) {
    session.lastActive = new Date().toISOString();
    session.messagePreview = cleanPreviewText(messagePreview);
    session.turnCount = conversationTurnCountForSession(id, session.turnCount);
    if (lastUsage) {
      (session as any).lastUsage = lastUsage;
    }
    writeStore(sessions);
  }
}

export function updateSessionContextUsage(id: string, contextUsage: any): void {
  const sessions = readStore();
  const session = sessions.find((s) => s.id === id);
  if (session) {
    (session as any).lastContextUsage = contextUsage;
    writeStore(sessions);
  }
}

// ── Message history per session ──

function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function historyFile(sessionId: string): string {
  return path.join(HISTORY_DIR, `${sessionId}.json`);
}

type HistoryCacheEntry = {
  file: string;
  size: number;
  mtimeMs: number;
  entries: HistoryEntry[];
};

const historyCache = new Map<string, HistoryCacheEntry>();

function readHistoryEntries(sessionId: string, options: { backfillUserUuids?: boolean } = {}): HistoryEntry[] {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  if (!fs.existsSync(file)) {
    historyCache.delete(sessionId);
    return [];
  }

  if (options.backfillUserUuids) {
    backfillUserUuids(sessionId);
  }

  const stat = fs.statSync(file);
  const cached = historyCache.get(sessionId);
  if (cached && cached.file === file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.entries;
  }

  const entries = JSON.parse(fs.readFileSync(file, "utf-8")) as HistoryEntry[];
  historyCache.set(sessionId, { file, size: stat.size, mtimeMs: stat.mtimeMs, entries });
  return entries;
}

function cleanPreviewText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function latestConversationPreviewFromEntries(entries: HistoryEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = cleanPreviewText(entry.content);
    if (text) return text;
  }
  return "";
}

function conversationTurnCountFromEntries(entries: HistoryEntry[]): number {
  return entries.reduce((count, entry) => {
    if (entry.role !== "user") return count;
    return cleanPreviewText(entry.content) ? count + 1 : count;
  }, 0);
}

function latestConversationPreviewFromHistory(sessionId: string): string {
  try {
    return latestConversationPreviewFromEntries(readHistoryEntries(sessionId));
  } catch {
    /* ignore stale/corrupt history */
  }
  return "";
}

function conversationTurnCountFromHistory(sessionId: string): number | undefined {
  try {
    if (!fs.existsSync(historyFile(sessionId))) return undefined;
    return conversationTurnCountFromEntries(readHistoryEntries(sessionId));
  } catch {
    /* ignore stale/corrupt history */
  }
  return undefined;
}

function latestConversationPreviewFromCodexRollout(sessionId: string): string {
  try {
    return latestConversationPreviewFromEntries(readCodexRolloutHistory(sessionId));
  } catch {
    /* ignore missing/corrupt rollout */
  }
  return "";
}

function conversationTurnCountFromCodexRollout(sessionId: string): number | undefined {
  try {
    if (!findCodexRolloutFile(sessionId)) return undefined;
    return conversationTurnCountFromEntries(readCodexRolloutHistory(sessionId));
  } catch {
    /* ignore missing/corrupt rollout */
  }
  return undefined;
}

function latestConversationPreviewForSession(sessionId: string): string {
  return (
    latestConversationPreviewFromHistory(sessionId) ||
    latestConversationPreviewFromSdkEvents(sessionId) ||
    latestConversationPreviewFromCodexRollout(sessionId)
  );
}

function normalizedTurnCount(value: unknown): number | undefined {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return undefined;
  return Math.floor(count);
}

function conversationTurnCountForSession(sessionId: string, fallback?: unknown): number {
  return (
    conversationTurnCountFromHistory(sessionId) ??
    conversationTurnCountFromCodexRollout(sessionId) ??
    normalizedTurnCount(fallback) ??
    0
  );
}

function withConversationTurnCount(session: SessionInfo): SessionInfo {
  return {
    ...session,
    turnCount: conversationTurnCountForSession(session.id, (session as any).turnCount),
  };
}

function writeHistoryEntries(sessionId: string, entries: HistoryEntry[]): void {
  ensureHistoryDir();
  const file = historyFile(sessionId);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf-8");
  const stat = fs.statSync(file);
  historyCache.set(sessionId, { file, size: stat.size, mtimeMs: stat.mtimeMs, entries });
}

export function appendHistory(sessionId: string, entry: HistoryEntry): void {
  const entries = readHistoryEntries(sessionId);
  entries.push(entry);
  writeHistoryEntries(sessionId, entries);
}

export function appendHistoryBulk(sessionId: string, newEntries: HistoryEntry[]): void {
  if (newEntries.length === 0) return;
  const entries = readHistoryEntries(sessionId);
  entries.push(...newEntries);
  writeHistoryEntries(sessionId, entries);
}

function nativeSyncTextKey(entry: HistoryEntry): string | null {
  if (entry.role !== "user" && entry.role !== "assistant") return null;
  const content = String(entry.content ?? "").trim().replace(/\s+/g, " ");
  if (!content) return null;
  return `${entry.role}\u0001${content}`;
}

function nativeSyncEntryKey(entry: HistoryEntry): string {
  const content = String(entry.content ?? "").trim().replace(/\s+/g, " ");
  return [
    entry.role,
    entry.toolName || "",
    entry.toolUseId || "",
    entry.filePath || "",
    content,
  ].join("\u0001");
}

/**
 * Append only the native transcript suffix that follows the latest local
 * user/assistant text entry. This is intentionally conservative: if we cannot
 * anchor the native transcript to the local tail, we do nothing rather than
 * appending an old transcript chunk to the end of the chat.
 */
export function appendNativeHistorySuffix(sessionId: string, nativeEntries: HistoryEntry[]): HistoryEntry[] {
  if (nativeEntries.length === 0) return [];
  let localEntries: HistoryEntry[] = [];
  try { localEntries = readHistoryEntries(sessionId); } catch { localEntries = []; }

  if (localEntries.length === 0) {
    writeHistoryEntries(sessionId, nativeEntries);
    return nativeEntries;
  }

  let localAnchorKey: string | null = null;
  for (let i = localEntries.length - 1; i >= 0; i--) {
    localAnchorKey = nativeSyncTextKey(localEntries[i]);
    if (localAnchorKey) break;
  }
  if (!localAnchorKey) return [];

  let nativeAnchorIndex = -1;
  for (let i = nativeEntries.length - 1; i >= 0; i--) {
    if (nativeSyncTextKey(nativeEntries[i]) === localAnchorKey) {
      nativeAnchorIndex = i;
      break;
    }
  }
  if (nativeAnchorIndex < 0) return [];

  const suffix = nativeEntries.slice(nativeAnchorIndex + 1);
  if (!suffix.some((entry) => nativeSyncTextKey(entry))) return [];

  const localCounts = new Map<string, number>();
  for (const entry of localEntries) {
    const key = nativeSyncEntryKey(entry);
    localCounts.set(key, (localCounts.get(key) || 0) + 1);
  }

  const missing: HistoryEntry[] = [];
  for (const entry of suffix) {
    const key = nativeSyncEntryKey(entry);
    const count = localCounts.get(key) || 0;
    if (count > 0) {
      localCounts.set(key, count - 1);
    } else {
      missing.push(entry);
    }
  }
  if (!missing.some((entry) => nativeSyncTextKey(entry))) return [];

  localEntries.push(...missing);
  writeHistoryEntries(sessionId, localEntries);
  return missing;
}

// Sessions whose user-uuid backfill has already run this process lifetime.
// Re-running is harmless but doubles the disk reads — once per restart is enough.
const _backfilledSessions = new Set<string>();

/**
 * Locate the Claude Code JSONL transcript for a session without needing the cwd.
 * Scans ~/.claude/projects/* for `<sessionId>.jsonl` and returns the first match.
 */
function findJsonlForSession(sessionId: string): string | undefined {
  const homeDir = process.env.HOME || require("os").homedir();
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return undefined;
  let projects: string[];
  try { projects = fs.readdirSync(projectsRoot); } catch { return undefined; }
  for (const proj of projects) {
    const p = path.join(projectsRoot, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Extract plain text from a Claude Code JSONL user message's content field. */
function extractJsonlUserText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

/**
 * Backfill UUIDs onto user history entries that pre-date self-assigned UUIDs.
 * Reads the Claude Code JSONL transcript for the session and matches user
 * entries by content in order. Idempotent: if no entries are missing UUIDs,
 * the JSONL is never read.
 */
export function backfillUserUuids(sessionId: string): void {
  if (_backfilledSessions.has(sessionId)) return;
  _backfilledSessions.add(sessionId);

  let entries: HistoryEntry[];
  try { entries = readHistoryEntries(sessionId, { backfillUserUuids: false }); } catch { return; }
  if (entries.length === 0) return;

  const missingIdx: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].role === "user" && !entries[i].uuid) missingIdx.push(i);
  }
  if (missingIdx.length === 0) return;

  const jsonlPath = findJsonlForSession(sessionId);
  if (!jsonlPath) return;

  // Pull user prompts from the JSONL in order. Skip entries that don't carry a
  // uuid (queue-operation rows etc.) and synthetic tool_result echoes.
  const jsonlUsers: { uuid: string; text: string }[] = [];
  try {
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== "user" || !row.uuid || !row.message) continue;
      const text = extractJsonlUserText(row.message.content);
      if (!text) continue;
      jsonlUsers.push({ uuid: row.uuid, text });
    }
  } catch { return; }

  if (jsonlUsers.length === 0) return;

  // Don't reuse UUIDs that other history entries already claim.
  const usedUuids = new Set<string>();
  for (const e of entries) {
    if (e.role === "user" && e.uuid) usedUuids.add(e.uuid);
  }
  const available = jsonlUsers.filter(j => !usedUuids.has(j.uuid));

  // Match in order, but a missing entry that can't be found doesn't stop the
  // rest of the run. The cursor only advances when we consume an entry.
  let cursor = 0;
  let changed = false;
  for (const idx of missingIdx) {
    const histText = entries[idx].content || "";
    let found = -1;
    for (let j = cursor; j < available.length; j++) {
      if (available[j].text === histText) { found = j; break; }
    }
    if (found >= 0) {
      entries[idx].uuid = available[found].uuid;
      cursor = found + 1;
      changed = true;
    }
  }

  if (changed) {
    writeHistoryEntries(sessionId, entries);
    console.log(`[Backfill] Restored UUIDs for ${sessionId} (${missingIdx.length} candidate entries)`);
  }
}

/** Assign UUID to the most recent user history entry (for rewind support) */
export function assignUserUuid(sessionId: string, uuid: string): void {
  try {
    const entries = readHistoryEntries(sessionId);
    if (entries.length === 0) return;
    // Walk backwards to find the most recent user entry without a uuid
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "user" && !entries[i].uuid) {
        entries[i].uuid = uuid;
        writeHistoryEntries(sessionId, entries);
        return;
      }
    }
  } catch {}
}

/** Mark a question entry as answered in the history file */
export function markQuestionAnswered(sessionId: string, questionId: string): void {
  try {
    const entries = readHistoryEntries(sessionId);
    if (entries.length === 0) return;
    const entry = entries.find(
      (e) => e.role === "question" && e.questionId === questionId
    );
    if (entry) {
      entry.answered = true;
      writeHistoryEntries(sessionId, entries);
    }
  } catch (e) {
    console.error(`[History] Error marking question answered: ${e}`);
  }
}

export function getHistory(sessionId: string): HistoryEntry[] {
  // Recover UUIDs on user prompts saved before self-assigned UUIDs (Apr 22 →
  // Apr 27). Once-per-process and a no-op when nothing's missing.
  return readHistoryEntries(sessionId, { backfillUserUuids: true });
}

/**
 * Get the last prompt suggestion stored in session history.
 * Returns the suggestion string, or undefined if none exists.
 */
export function getLastPromptSuggestion(sessionId: string): string | undefined {
  const all = getHistory(sessionId);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === "prompt_suggestion") {
      return all[i].content;
    }
  }
  return undefined;
}

/**
 * Get a page of history entries.
 * Returns the most recent `limit` entries by default, or entries starting at `offset`.
 * offset is 0-based from the start (oldest) of the array.
 */
export function getHistoryPage(
  sessionId: string,
  limit: number,
  offset?: number
): { entries: HistoryEntry[]; total: number; offset: number } {
  const all = getHistory(sessionId);
  const total = all.length;
  if (total === 0) {
    return { entries: [], total: 0, offset: 0 };
  }

  let start: number;
  if (offset !== undefined) {
    start = Math.max(0, offset);
  } else {
    // Default: last `limit` entries
    start = Math.max(0, total - limit);
  }
  const end = Math.min(start + limit, total);
  return { entries: all.slice(start, end), total, offset: start };
}

/**
 * Get history page that includes at least back to the user's most recent prompt.
 * Ensures the app has enough context to render subagent tasks properly.
 */
export function getHistoryPageToLastPrompt(
  sessionId: string,
  minEntries: number = 50
): { entries: HistoryEntry[]; total: number; offset: number } {
  const all = getHistory(sessionId);
  const total = all.length;
  if (total === 0) {
    return { entries: [], total: 0, offset: 0 };
  }

  // Default start: last minEntries
  let start = Math.max(0, total - minEntries);

  // Find the last user message and ensure we include it
  for (let i = total - 1; i >= 0; i--) {
    if (all[i].role === "user") {
      start = Math.min(start, i);
      break;
    }
  }

  return { entries: all.slice(start), total, offset: start };
}

/**
 * Truncate history at a specific user message UUID.
 * Keeps all entries up to and including the entry with the given UUID.
 * Returns the number of entries removed, or -1 if UUID not found.
 */
export function truncateHistoryAtMessage(
  sessionId: string,
  userMessageUuid: string
): { removed: number; kept: number } {
  const all = getHistory(sessionId);
  // Find the index of the user message with this UUID
  const idx = all.findIndex(
    (e) => e.uuid === userMessageUuid && e.role === "user"
  );
  if (idx === -1) {
    // Try matching any role with this UUID (user_uuid entries store UUID differently)
    const altIdx = all.findIndex((e) => e.uuid === userMessageUuid);
    if (altIdx === -1) return { removed: -1, kept: all.length };
    const kept = all.slice(0, altIdx + 1);
    const removed = all.length - kept.length;
    writeHistoryEntries(sessionId, kept);
    return { removed, kept: kept.length };
  }
  const kept = all.slice(0, idx + 1);
  const removed = all.length - kept.length;
  writeHistoryEntries(sessionId, kept);
  return { removed, kept: kept.length };
}

// ── Per-session todo list ──

const TODOS_DIR = path.join(STORE_DIR, "todos");

function ensureTodosDir(): void {
  if (!fs.existsSync(TODOS_DIR)) {
    fs.mkdirSync(TODOS_DIR, { recursive: true });
  }
}

function todosFile(sessionId: string): string {
  return path.join(TODOS_DIR, `${sessionId}.json`);
}

export function saveTodos(sessionId: string, todos: any[]): void {
  ensureTodosDir();
  fs.writeFileSync(todosFile(sessionId), JSON.stringify(todos, null, 2), "utf-8");
}

export function getTodos(sessionId: string): any[] {
  ensureTodosDir();
  const file = todosFile(sessionId);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/** Sanitize CWD to match the SDK's project directory naming convention.
 *  Works on both Unix (/home/user/code) and Windows (C:\Users\user\code) paths. */
function sanitizeCwdToProjectDir(cwd: string): string {
  let dir = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (dir.length > 200) {
    let hash = 0;
    for (let i = 0; i < cwd.length; i++) {
      hash = (hash << 5) - hash + cwd.charCodeAt(i);
      hash |= 0;
    }
    dir = dir.slice(0, 200) + "-" + Math.abs(hash).toString(36);
  }
  return dir;
}

/** Build the path to Claude Code's JSONL session file */
export function getJsonlPath(sessionId: string, cwd: string): string {
  const homeDir = process.env.HOME || require("os").homedir();
  const projectDir = sanitizeCwdToProjectDir(cwd);
  return path.join(homeDir, ".claude", "projects", projectDir, `${sessionId}.jsonl`);
}

/** Get the timestamp of the last entry in a session's history */
export function getLastHistoryTimestamp(sessionId: string): string {
  const history = getHistory(sessionId);
  return history.length > 0 ? history[history.length - 1].timestamp : "";
}

/**
 * Read missed messages from Claude Code's own session JSONL file.
 * Returns HistoryEntry[] for messages that occurred after `afterTimestamp`.
 * This fills gaps when the server was down but Claude kept working.
 */
export function getMissedMessages(
  sessionId: string,
  cwd: string,
  afterTimestamp: string
): HistoryEntry[] {
  const jsonlPath = getJsonlPath(sessionId, cwd);

  if (!fs.existsSync(jsonlPath)) return [];

  const afterTime = new Date(afterTimestamp).getTime();
  const entries: HistoryEntry[] = [];

  try {
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);

    for (const line of lines) {
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      // Skip messages before our cutoff
      if (!msg.timestamp) continue;
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime <= afterTime) continue;

      // Convert to our HistoryEntry format
      if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        // Extract text
        const textParts = Array.isArray(content)
          ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
          : "";
        if (textParts) {
          entries.push({
            role: "assistant",
            content: textParts,
            timestamp: msg.timestamp,
          });
        }
        // Extract tool calls
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              entries.push({
                role: "tool_call",
                content: "",
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,
                timestamp: msg.timestamp,
              });
            }
          }
        }
      } else if (msg.type === "user" && msg.message?.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const output = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : "";
              entries.push({
                role: "tool_result",
                content: "",
                toolUseId: block.tool_use_id || "",
                toolOutput: output.slice(0, 2000), // Truncate large outputs
                timestamp: msg.timestamp,
              });
            } else if (block.type === "text") {
              entries.push({
                role: "user",
                content: block.text,
                timestamp: msg.timestamp,
              });
            }
          }
        } else if (typeof content === "string") {
          entries.push({
            role: "user",
            content,
            timestamp: msg.timestamp,
          });
        }
      }
    }
  } catch (e) {
    console.error(`[MissedMessages] Error reading JSONL: ${e}`);
  }

  return entries;
}

// ── SDK event history (separate JSONL files per session) ──

const SDK_EVENTS_DIR = path.join(STORE_DIR, "sdk-events");

function ensureSdkEventsDir(): void {
  if (!fs.existsSync(SDK_EVENTS_DIR)) {
    fs.mkdirSync(SDK_EVENTS_DIR, { recursive: true });
  }
}

function sdkEventsFile(sessionId: string): string {
  return path.join(SDK_EVENTS_DIR, `${sessionId}.jsonl`);
}

/** Append a single SDK event to the session's JSONL file */
export function appendSdkEvent(sessionId: string, event: Record<string, any>): void {
  ensureSdkEventsDir();
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(sdkEventsFile(sessionId), line, "utf-8");
}

/** Read recent SDK events for a session. Raw history can be huge, so cap it. */
export function getSdkEvents(sessionId: string, limit = 300): Record<string, any>[] {
  ensureSdkEventsDir();
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    return readJsonlTailLines(file, { maxLines: Math.max(1, limit), maxBytes: 16 * 1024 * 1024 })
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as Record<string, any>[];
  } catch {
    return [];
  }
}

function readJsonlTailLines(
  file: string,
  options: { maxLines?: number; maxBytes?: number } = {}
): string[] {
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? 300));
  const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  const stat = fs.statSync(file);
  if (stat.size === 0) return [];

  const fd = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let position = stat.size;
    let totalBytes = 0;
    let newlineCount = 0;

    while (position > 0 && totalBytes < maxBytes && newlineCount <= maxLines) {
      const readSize = Math.min(64 * 1024, position, maxBytes - totalBytes);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const bytesRead = fs.readSync(fd, buffer, 0, readSize, position);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      totalBytes += bytesRead;
      for (const byte of chunk) {
        if (byte === 10) newlineCount++;
      }
    }

    const lines = Buffer.concat(chunks).toString("utf-8").split("\n");
    if (position > 0) lines.shift();
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function appServerUserContentPreview(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const input = part as any;
      if (input.type === "text") return String(input.text ?? "");
      if (input.type === "input_text") return String(input.text ?? "");
      if (input.type === "skill") return `/${String(input.name ?? "skill")}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function appServerItemPreview(item: any): string {
  if (!item || typeof item !== "object") return "";
  if (item.type === "agentMessage") {
    return cleanPreviewText(item.text);
  }
  if (item.type === "userMessage") {
    return cleanPreviewText(appServerUserContentPreview(item.content));
  }
  return "";
}

function latestConversationPreviewFromSdkEvents(sessionId: string): string {
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return "";
  try {
    const lines = readJsonlTailLines(file, { maxLines: 1200, maxBytes: 16 * 1024 * 1024 });
    for (let i = lines.length - 1; i >= 0; i--) {
      let event: any;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const method = String(event?.method || "");
      if (method !== "item/completed" && method !== "item/started") continue;
      const preview = appServerItemPreview(event?.params?.item);
      if (preview) return preview;
    }
  } catch {
    /* ignore missing/corrupt sdk event history */
  }
  return "";
}

/** Get SDK event count for a session (for deciding whether to send) */
export function getSdkEventCount(sessionId: string): number {
  const file = sdkEventsFile(sessionId);
  if (!fs.existsSync(file)) return 0;
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const ARCHIVE_DIR = path.join(STORE_DIR, "archive");

function ensureArchiveDir(): void {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

/**
 * Clear context for a session: archive the backend transcript, our history, and todos.
 * The session metadata (sessions.json) is preserved so it still shows in the list.
 * Archived files get a timestamp suffix so multiple clears don't overwrite.
 */
export function clearSessionContext(sessionId: string, cwd: string): void {
  ensureArchiveDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sessions = readStore();
  const session = sessions.find((s) => s.id === sessionId);
  const backend = session?.backend;
  let codexRolloutPath: string | undefined;

  // 1. Archive the backend's native transcript.
  if (backend === "codex") {
    const rolloutPath = findCodexRolloutFile(sessionId);
    if (rolloutPath && fs.existsSync(rolloutPath)) {
      codexRolloutPath = rolloutPath;
      const archiveName = `${sessionId}_${ts}_codex-rollout.jsonl`;
      fs.copyFileSync(rolloutPath, path.join(ARCHIVE_DIR, archiveName));
      archiveCodexNativeRollout(sessionId, rolloutPath);
      console.log(`[ClearContext] Archived Codex rollout: ${archiveName}`);
    }
  } else {
    const jsonlPath = getJsonlPath(sessionId, cwd);
    if (fs.existsSync(jsonlPath)) {
      const archiveName = `${sessionId}_${ts}.jsonl`;
      fs.renameSync(jsonlPath, path.join(ARCHIVE_DIR, archiveName));
      console.log(`[ClearContext] Archived JSONL: ${archiveName}`);
    }
  }

  // 2. Archive our chat history
  const histFile = historyFile(sessionId);
  if (fs.existsSync(histFile)) {
    const archiveName = `${sessionId}_${ts}_history.json`;
    fs.renameSync(histFile, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived history: ${archiveName}`);
  }

  // 3. Archive todos
  const todoFile = todosFile(sessionId);
  if (fs.existsSync(todoFile)) {
    const archiveName = `${sessionId}_${ts}_todos.json`;
    fs.renameSync(todoFile, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived todos: ${archiveName}`);
  }

  // 4. Archive SDK events
  const sdkFile = sdkEventsFile(sessionId);
  if (fs.existsSync(sdkFile)) {
    const archiveName = `${sessionId}_${ts}_sdk-events.jsonl`;
    fs.renameSync(sdkFile, path.join(ARCHIVE_DIR, archiveName));
    console.log(`[ClearContext] Archived SDK events: ${archiveName}`);
  }

  // 5. Write a metadata sidecar so restore can recover the title/cwd
  // even after the session row has been remapped to a new SDK session id.
  if (session) {
    const clearedAt = new Date().toISOString();
    const metaName = `${sessionId}_${ts}_meta.json`;
    const meta = {
      sid: sessionId,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      clearedAt,
      ...(session.backend ? { backend: session.backend } : {}),
      ...((session as any).codexDriver ? { codexDriver: (session as any).codexDriver } : {}),
      ...(codexRolloutPath ? { codexRolloutPath } : {}),
    };
    fs.writeFileSync(path.join(ARCHIVE_DIR, metaName), JSON.stringify(meta, null, 2), "utf-8");
    console.log(`[ClearContext] Wrote meta: ${metaName}`);

    // 6. Update session metadata to reflect the clear
    session.messagePreview = "(context cleared)";
    session.lastActive = new Date().toISOString();
    (session as any).contextClearedAt = clearedAt;
    delete (session as any).lastContextUsage;
    writeStore(sessions);
  }
}

export interface ArchiveEntry {
  sid: string;
  ts: string;
  title: string;
  cwd: string;
  backend?: Backend;
  createdAt: string;
  clearedAt: string;
  messagePreview: string;
  messageCount: number;
  hasJsonl: boolean;
}

const CODEX_NATIVE_ARCHIVE_TS_PREFIX = "codex-native-";

const ARCHIVE_SUFFIXES: Array<[string, string]> = [
  ["_codex-rollout.jsonl", "codex-rollout"],
  ["_sdk-events.jsonl", "sdk-events"],
  ["_history.json", "history"],
  ["_todos.json", "todos"],
  ["_meta.json", "meta"],
  [".jsonl", "jsonl"],
];

function parseArchiveFilename(name: string): { sid: string; ts: string; kind: string } | null {
  for (const [suffix, kind] of ARCHIVE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      const underscoreIdx = base.lastIndexOf("_");
      if (underscoreIdx < 0) return null;
      return { sid: base.slice(0, underscoreIdx), ts: base.slice(underscoreIdx + 1), kind };
    }
  }
  return null;
}

export function listArchives(): ArchiveEntry[] {
  ensureArchiveDir();
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  const files = fs.readdirSync(ARCHIVE_DIR);
  const groups = new Map<string, { sid: string; ts: string; files: Map<string, string> }>();
  for (const f of files) {
    const parsed = parseArchiveFilename(f);
    if (!parsed) continue;
    const key = `${parsed.sid}_${parsed.ts}`;
    let group = groups.get(key);
    if (!group) {
      group = { sid: parsed.sid, ts: parsed.ts, files: new Map() };
      groups.set(key, group);
    }
    group.files.set(parsed.kind, f);
  }

  const entries: ArchiveEntry[] = [];
  for (const group of groups.values()) {
    let title = "";
    let cwd = "";
    let backend: Backend | undefined;
    let createdAt = "";
    // Timestamp encoding in the archive filename is `toISOString().replace(/[:.]/g, "-")`.
    // Reverse it: the first three dashes after `T` were `:`/`:`/`.` in the original.
    let clearedAt = tsToIso(group.ts);
    const metaName = group.files.get("meta");
    if (metaName) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, metaName), "utf-8"));
        if (typeof meta.title === "string" && meta.title) title = meta.title;
        if (typeof meta.cwd === "string" && meta.cwd) cwd = meta.cwd;
        if (meta.backend === "claude" || meta.backend === "codex") backend = meta.backend;
        if (typeof meta.createdAt === "string") createdAt = meta.createdAt;
        if (typeof meta.clearedAt === "string" && meta.clearedAt) clearedAt = meta.clearedAt;
      } catch {}
    }

    let messagePreview = "";
    let messageCount = 0;
    const histName = group.files.get("history");
    if (histName) {
      try {
        const hist = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, histName), "utf-8")) as any[];
        messageCount = Array.isArray(hist) ? hist.length : 0;
        const firstUser = (hist as any[]).find((e) => e.role === "user");
        if (firstUser) messagePreview = String(firstUser.content || "").slice(0, 200);
      } catch {}
    }

    // Title fallback: the session's first user message, trimmed to a single line.
    if (!title && messagePreview) {
      const firstLine = messagePreview.split(/\r?\n/)[0].trim();
      title = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine || "Untitled";
    }
    if (!title) title = "Untitled";

    // cwd fallback: pull from the archived backend transcript.
    const jsonlName = group.files.get("jsonl");
    if (!cwd && jsonlName) {
      try {
        const buf = fs.readFileSync(path.join(ARCHIVE_DIR, jsonlName), "utf-8");
        const firstLine = buf.split("\n", 1)[0];
        if (firstLine) {
          const obj = JSON.parse(firstLine);
          if (typeof obj.cwd === "string") cwd = obj.cwd;
        }
      } catch {}
    }
    const codexRolloutName = group.files.get("codex-rollout");
    if (!backend && codexRolloutName) backend = "codex";
    if (!cwd && codexRolloutName) {
      try {
        const firstLine = fs.readFileSync(path.join(ARCHIVE_DIR, codexRolloutName), "utf-8").split("\n", 1)[0];
        if (firstLine) {
          const obj = JSON.parse(firstLine);
          if (obj?.type === "session_meta" && typeof obj.payload?.cwd === "string") {
            cwd = obj.payload.cwd;
          }
        }
      } catch {}
    }

    entries.push({
      sid: group.sid,
      ts: group.ts,
      title,
      cwd,
      ...(backend ? { backend } : {}),
      createdAt,
      clearedAt,
      messagePreview,
      messageCount,
      hasJsonl: group.files.has("jsonl") || group.files.has("codex-rollout"),
    });
  }

  for (const native of listCodexNativeArchives()) {
    const existingIdx = entries.findIndex((entry) => entry.sid === native.sid && entry.backend === "codex");
    if (existingIdx >= 0) {
      entries[existingIdx] = {
        ...native,
        title: entries[existingIdx].title || native.title,
        messagePreview: entries[existingIdx].messagePreview || native.messagePreview,
        messageCount: entries[existingIdx].messageCount || native.messageCount,
      };
    } else {
      entries.push(native);
    }
  }

  return entries.sort((a, b) => b.clearedAt.localeCompare(a.clearedAt));
}

function tsToIso(ts: string): string {
  // `2026-04-22T10-30-45-123Z` → `2026-04-22T10:30:45.123Z`
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)(Z?)$/);
  if (!m) return ts;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}${m[6] || "Z"}`;
}

export function getArchiveHistory(sid: string, ts: string): HistoryEntry[] {
  const p = path.join(ARCHIVE_DIR, `${sid}_${ts}_history.json`);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

export function restoreArchive(sid: string, ts: string): { ok: true; session: SessionInfo } | { ok: false; reason: string } {
  ensureArchiveDir();

  if (isCodexNativeArchiveTs(ts)) {
    const native = getCodexThreadSessionInfo(sid);
    if (!native) return { ok: false, reason: "Codex thread not found" };
    const restoredAt = new Date().toISOString();
    const sessions = readStore();
    const existingIdx = sessions.findIndex((s) => s.id === sid);
    const restored: SessionInfo = {
      ...native,
      lastActive: restoredAt,
      codexDriver: "app-server",
    } as SessionInfo;
    if (existingIdx >= 0) {
      sessions[existingIdx] = restored;
    } else {
      sessions.push(restored);
    }
    writeStore(sessions);
    return { ok: true, session: restored };
  }

  const metaPath = path.join(ARCHIVE_DIR, `${sid}_${ts}_meta.json`);
  const jsonlArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}.jsonl`);
  const codexRolloutArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_codex-rollout.jsonl`);
  const histArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_history.json`);
  const todosArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_todos.json`);
  const sdkEventsArchive = path.join(ARCHIVE_DIR, `${sid}_${ts}_sdk-events.jsonl`);

  let metaTitle = "";
  let metaCreatedAt = "";
  let metaBackend: Backend | undefined;
  let metaCodexDriver: string | undefined;
  let codexRolloutPath = "";
  let cwd = "";
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (typeof meta.title === "string") metaTitle = meta.title;
      if (typeof meta.createdAt === "string") metaCreatedAt = meta.createdAt;
      if (typeof meta.cwd === "string") cwd = meta.cwd;
      if (meta.backend === "claude" || meta.backend === "codex") metaBackend = meta.backend;
      if (meta.codexDriver === "exec" || meta.codexDriver === "app-server") metaCodexDriver = meta.codexDriver;
      if (typeof meta.codexRolloutPath === "string") codexRolloutPath = meta.codexRolloutPath;
    } catch {}
  }

  // cwd fallback: first line of the archived JSONL carries the session's cwd.
  if (!cwd && fs.existsSync(jsonlArchive)) {
    try {
      const firstLine = fs.readFileSync(jsonlArchive, "utf-8").split("\n", 1)[0];
      if (firstLine) {
        const obj = JSON.parse(firstLine);
        if (typeof obj.cwd === "string") cwd = obj.cwd;
      }
    } catch {}
  }
  if (!cwd && fs.existsSync(codexRolloutArchive)) {
    try {
      const firstLine = fs.readFileSync(codexRolloutArchive, "utf-8").split("\n", 1)[0];
      if (firstLine) {
        const obj = JSON.parse(firstLine);
        if (obj?.type === "session_meta" && typeof obj.payload?.cwd === "string") {
          cwd = obj.payload.cwd;
        }
      }
    } catch {}
  }
  if (!cwd) return { ok: false, reason: "cannot determine cwd for this archive" };

  const liveHist = historyFile(sid);
  const liveJsonl = getJsonlPath(sid, cwd);
  let restoredCodexRolloutPath = "";

  if (fs.existsSync(jsonlArchive)) {
    const destDir = path.dirname(liveJsonl);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(liveJsonl)) fs.unlinkSync(liveJsonl);
    fs.renameSync(jsonlArchive, liveJsonl);
  }
  if (fs.existsSync(codexRolloutArchive)) {
    const homeDir = process.env.HOME || require("os").homedir();
    const archivedRoot = path.resolve(path.join(homeDir, ".codex", "archived_sessions"));
    const metaRolloutPath = codexRolloutPath && !path.resolve(codexRolloutPath).startsWith(archivedRoot + path.sep)
      ? codexRolloutPath
      : "";
    const liveCodexRollout = metaRolloutPath || buildCodexRolloutRestorePath(sid, codexRolloutArchive) || findCodexRolloutFile(sid);
    if (!liveCodexRollout) {
      return { ok: false, reason: "cannot determine Codex rollout path for this archive" };
    }
    const destDir = path.dirname(liveCodexRollout);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(liveCodexRollout)) fs.unlinkSync(liveCodexRollout);
    fs.renameSync(codexRolloutArchive, liveCodexRollout);
    restoredCodexRolloutPath = liveCodexRollout;
  }
  if (fs.existsSync(histArchive)) {
    ensureHistoryDir();
    if (fs.existsSync(liveHist)) fs.unlinkSync(liveHist);
    fs.renameSync(histArchive, liveHist);
  }
  if (fs.existsSync(todosArchive)) {
    ensureTodosDir();
    const liveTodos = todosFile(sid);
    if (fs.existsSync(liveTodos)) fs.unlinkSync(liveTodos);
    fs.renameSync(todosArchive, liveTodos);
  }
  if (fs.existsSync(sdkEventsArchive)) {
    ensureSdkEventsDir();
    const liveSdkEvents = sdkEventsFile(sid);
    if (fs.existsSync(liveSdkEvents)) fs.unlinkSync(liveSdkEvents);
    fs.renameSync(sdkEventsArchive, liveSdkEvents);
  }
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  const restoredAt = new Date().toISOString();
  let messagePreview = "";
  let titleFallback = "";
  let turnCount = 0;
  try {
    const hist = JSON.parse(fs.readFileSync(liveHist, "utf-8")) as any[];
    turnCount = Array.isArray(hist) ? conversationTurnCountFromEntries(hist as HistoryEntry[]) : 0;
    const lastUser = [...hist].reverse().find((e) => e.role === "user");
    if (lastUser) messagePreview = String(lastUser.content || "").slice(0, 200);
    const firstUser = (hist as any[]).find((e) => e.role === "user");
    if (firstUser) {
      const line = String(firstUser.content || "").split(/\r?\n/)[0].trim();
      titleFallback = line.length > 60 ? line.slice(0, 60) + "…" : line;
    }
  } catch {}

  const sessions = readStore();
  const existingIdx = sessions.findIndex((s) => s.id === sid);
  const restored: SessionInfo = {
    id: sid,
    title: metaTitle || titleFallback || "Untitled",
    cwd,
    createdAt: metaCreatedAt || restoredAt,
    lastActive: restoredAt,
    messagePreview,
    turnCount,
    ...(metaBackend ? { backend: metaBackend } : {}),
    ...(metaCodexDriver ? { codexDriver: metaCodexDriver as any } : {}),
  };
  if (existingIdx >= 0) {
    sessions[existingIdx] = restored;
  } else {
    sessions.push(restored);
  }
  writeStore(sessions);
  if (restored.backend === "codex" && restoredCodexRolloutPath) {
    updateCodexThreadRolloutState(sid, restoredCodexRolloutPath, false);
  }
  console.log(`[RestoreArchive] Restored ${sid}_${ts} (title="${restored.title}", cwd=${cwd})`);

  return { ok: true, session: restored };
}

export function deleteArchive(sid: string, ts: string): void {
  ensureArchiveDir();
  if (isCodexNativeArchiveTs(ts)) return;
  for (const suffix of [".jsonl", "_codex-rollout.jsonl", "_history.json", "_todos.json", "_sdk-events.jsonl", "_meta.json"]) {
    const p = path.join(ARCHIVE_DIR, `${sid}_${ts}${suffix}`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[DeleteArchive] Removed ${sid}_${ts}${suffix}`);
    }
  }
}

export function isCodexNativeArchiveTs(ts: string): boolean {
  return ts.startsWith(CODEX_NATIVE_ARCHIVE_TS_PREFIX);
}

const CODEX_THREAD_LIST_SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"];
const CODEX_THREAD_LOOKUP_SOURCE_KINDS = ["cli", "exec", "vscode", "appServer", "unknown"];
const CODEX_THREAD_LIST_LIMIT = 500;
const CODEX_NATIVE_LIST_CACHE_MS = 10_000;

let codexNativeSessionsCache:
  | { at: number; sessions: SessionInfo[] }
  | null = null;
let codexNativeArchivesCache:
  | { at: number; archives: ArchiveEntry[] }
  | null = null;

export function invalidateCodexNativeListCache(): void {
  codexNativeSessionsCache = null;
  codexNativeArchivesCache = null;
}

async function withCodexThreadListClient<T>(
  cwd: string,
  fn: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const client = new CodexAppServerClient({
    cwd,
    env: process.env,
    requestTimeoutMs: 20_000,
    startupTimeoutMs: 20_000,
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

function unixSecondsToIso(value: unknown, fallback = nowIso()): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n * 1000).toISOString();
}

function codexThreadTitle(thread: any): string {
  const raw = String(thread?.name || thread?.preview || "").trim();
  const firstLine = raw.split(/\r?\n/)[0].trim();
  const title = firstLine || "Codex session";
  return title.length > 80 ? title.slice(0, 80) + "…" : title;
}

function codexThreadPreview(thread: any): string {
  return String(thread?.preview || "").trim().slice(0, 200);
}

function codexThreadPayloadIsArchived(thread: any): boolean {
  const archived = (thread as any)?.archived;
  if (archived === true || archived === 1 || archived === "1") return true;
  if (typeof archived === "string" && archived.toLowerCase() === "true") return true;
  return false;
}

function codexThreadToSessionInfo(thread: any, stored?: SessionInfo): SessionInfo | null {
  const id = String(thread?.id || thread?.threadId || "").trim();
  const cwd = String(thread?.cwd || stored?.cwd || "").trim();
  if (!id || !cwd) return null;
  const createdAt = unixSecondsToIso(thread?.createdAt, stored?.createdAt || nowIso());
  const lastActive = unixSecondsToIso(thread?.updatedAt, stored?.lastActive || createdAt);
  const preview = codexThreadPreview(thread);
  const recentPreview = stored ? latestConversationPreviewForSession(id) : "";
  return {
    ...(stored || {}),
    id,
    title: codexThreadTitle(thread),
    cwd,
    createdAt,
    lastActive,
    messagePreview: recentPreview || stored?.messagePreview || preview || "",
    turnCount: conversationTurnCountForSession(id, stored?.turnCount),
    backend: "codex",
    codexDriver: "app-server",
  } as SessionInfo;
}

function codexThreadToArchiveEntry(thread: any): ArchiveEntry | null {
  const session = codexThreadToSessionInfo(thread);
  if (!session) return null;
  const archivedAt = unixSecondsToIso((thread as any)?.archivedAt, session.lastActive);
  return {
    sid: session.id,
    ts: `${CODEX_NATIVE_ARCHIVE_TS_PREFIX}${Math.floor(new Date(archivedAt).getTime() / 1000) || Date.now()}`,
    title: session.title,
    cwd: session.cwd,
    backend: "codex",
    createdAt: session.createdAt,
    clearedAt: archivedAt,
    messagePreview: session.messagePreview,
    messageCount: 0,
    hasJsonl: true,
  };
}

async function listAllCodexThreads(params: CodexAppServerThreadListParams): Promise<any[]> {
  return withCodexThreadListClient(getDefaultProcessCwd(), async (client) => {
    const maxRows = Math.max(
      1,
      Math.min(CODEX_THREAD_LIST_LIMIT, Math.floor(Number(params.limit ?? CODEX_THREAD_LIST_LIMIT))),
    );
    const threads: any[] = [];
    let cursor: string | null | undefined = params.cursor ?? null;
    do {
      const response = await client.listThreads({
        ...params,
        cursor,
        limit: Math.max(1, Math.min(maxRows - threads.length, maxRows)),
      }) as any;
      const page = Array.isArray(response?.data) ? response.data : [];
      threads.push(...page);
      cursor = response?.nextCursor || null;
    } while (cursor && threads.length < maxRows);
    return threads.slice(0, maxRows);
  });
}

function getDefaultProcessCwd(): string {
  return process.cwd();
}

async function listCodexNativeSessionsFromAppServer(useCache = true): Promise<SessionInfo[]> {
  const nowMs = Date.now();
  if (useCache && codexNativeSessionsCache && nowMs - codexNativeSessionsCache.at < CODEX_NATIVE_LIST_CACHE_MS) {
    return codexNativeSessionsCache.sessions;
  }

  const stored = readStore();
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const threads = await listAllCodexThreads({
    archived: false,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: CODEX_THREAD_LIST_SOURCE_KINDS,
    useStateDbOnly: true,
  });
  const sessions = threads.flatMap((thread): SessionInfo[] => {
    const id = String(thread?.id || "");
    const info = codexThreadToSessionInfo(thread, storedById.get(id));
    return info ? [info] : [];
  });
  codexNativeSessionsCache = { at: nowMs, sessions };
  return sessions;
}

export async function listSessionsWithNativeCodex(useCache = true): Promise<SessionInfo[]> {
  const stored = listSessions();
  let native: SessionInfo[];
  try {
    native = await listCodexNativeSessionsFromAppServer(useCache);
  } catch (err: any) {
    console.warn(`[CodexThreads] native session list failed: ${err?.message || String(err)}`);
    return stored.map(withConversationTurnCount);
  }

  const nativeById = new Map(native.map((s) => [s.id, s]));
  const merged: SessionInfo[] = [];
  for (const session of stored) {
    const nativeSession = nativeById.get(session.id);
    if (nativeSession) {
      const recentPreview = latestConversationPreviewForSession(session.id);
      merged.push({
        ...session,
        ...nativeSession,
        messagePreview: recentPreview || session.messagePreview || nativeSession.messagePreview,
        turnCount: conversationTurnCountForSession(
          session.id,
          session.turnCount ?? nativeSession.turnCount,
        ),
        lastUsage: session.lastUsage,
        scheduledTaskId: session.scheduledTaskId,
        permissionMode: session.permissionMode,
        contextClearedAt: session.contextClearedAt,
        ...(session as any).lastContextUsage ? { lastContextUsage: (session as any).lastContextUsage } : {},
      } as SessionInfo);
      nativeById.delete(session.id);
      continue;
    }

    if (
      session.backend === "codex"
      && (session as any).codexDriver === "app-server"
      && !(session as any).contextClearedAt
      && isCodexThreadArchived(session.id)
    ) {
      deleteSession(session.id);
      console.log(`[CodexThreads] Removed archived native Codex session ${session.id} from SocketAgent store`);
      continue;
    }

    merged.push(withConversationTurnCount(session));
  }

  merged.push(...Array.from(nativeById.values()).map(withConversationTurnCount));
  return merged.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
}

export async function listArchivesWithNativeCodex(useCache = true): Promise<ArchiveEntry[]> {
  const legacy = listArchives();
  const nowMs = Date.now();
  let nativeArchives: ArchiveEntry[];
  if (useCache && codexNativeArchivesCache && nowMs - codexNativeArchivesCache.at < CODEX_NATIVE_LIST_CACHE_MS) {
    nativeArchives = codexNativeArchivesCache.archives;
  } else {
    try {
      const threads = await listAllCodexThreads({
        archived: true,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: CODEX_THREAD_LOOKUP_SOURCE_KINDS,
        useStateDbOnly: true,
      });
      nativeArchives = threads.flatMap((thread): ArchiveEntry[] => {
        const entry = codexThreadToArchiveEntry(thread);
        return entry ? [entry] : [];
      });
      codexNativeArchivesCache = { at: nowMs, archives: nativeArchives };
    } catch (err: any) {
      console.warn(`[CodexThreads] native archive list failed: ${err?.message || String(err)}`);
      nativeArchives = listCodexNativeArchives();
    }
  }

  const byKey = new Map<string, ArchiveEntry>();
  for (const entry of legacy) byKey.set(`${entry.backend || ""}:${entry.sid}`, entry);
  for (const entry of nativeArchives) byKey.set(`codex:${entry.sid}`, entry);
  return [...byKey.values()].sort((a, b) => b.clearedAt.localeCompare(a.clearedAt));
}

export async function getCodexNativeThreadSessionInfo(sessionId: string, cwd = getDefaultProcessCwd()): Promise<SessionInfo | null> {
  if (isCodexThreadArchived(sessionId)) {
    return null;
  }
  try {
    return await withCodexThreadListClient(cwd, async (client) => {
      const response = await client.readThread({ threadId: sessionId, includeTurns: false }) as any;
      if (codexThreadPayloadIsArchived(response?.thread)) return null;
      return codexThreadToSessionInfo(response?.thread);
    });
  } catch (err: any) {
    console.warn(`[CodexThreads] thread/read failed for ${sessionId}: ${err?.message || String(err)}`);
    if (isCodexThreadArchived(sessionId)) return null;
    return getCodexThreadSessionInfo(sessionId);
  }
}

export async function restoreCodexNativeArchive(sessionId: string, cwd = getDefaultProcessCwd()): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: string }> {
  try {
    const session = await withCodexThreadListClient(cwd, async (client) => {
      const response = await client.unarchiveThread(sessionId) as any;
      const fromResponse = codexThreadToSessionInfo(response?.thread);
      if (fromResponse) return fromResponse;
      const read = await client.readThread({ threadId: sessionId, includeTurns: false }) as any;
      return codexThreadToSessionInfo(read?.thread);
    });
    if (!session) return { ok: false, reason: "Codex thread not found" };
    saveSession({ ...session, lastActive: nowIso(), codexDriver: "app-server" } as SessionInfo);
    invalidateCodexNativeListCache();
    return { ok: true, session: getSession(sessionId) || session };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

export async function renameCodexNativeThread(sessionId: string, cwd: string, title: string): Promise<void> {
  await withCodexThreadListClient(cwd || getDefaultProcessCwd(), async (client) => {
    await client.setThreadName(sessionId, title);
  });
  const session = getSession(sessionId);
  if (session) {
    session.title = title;
    session.lastActive = nowIso();
    saveSession(session);
  }
  invalidateCodexNativeListCache();
}

export async function listCodexNativeSdkSessions(cwd: string, limit = 30): Promise<SdkSessionEntry[]> {
  const cwdCandidates = cwdLookupCandidates(cwd);
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of readStore()) {
    if (s.backend === "codex" && setsIntersect(cwdLookupCandidates(s.cwd), cwdCandidates)) {
      trackedMap.set(s.id, s);
    }
  }

  const threads = await listAllCodexThreads({
    archived: false,
    cwd: [...cwdCandidates],
    limit: Math.max(1, Math.min(200, Math.floor(limit))),
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: CODEX_THREAD_LOOKUP_SOURCE_KINDS,
    useStateDbOnly: true,
  });
  return threads.flatMap((thread): SdkSessionEntry[] => {
    const id = String(thread?.id || "");
    const info = codexThreadToSessionInfo(thread, trackedMap.get(id));
    if (!id || !info) return [];
    return [{
      sessionId: id,
      firstMessage: info.messagePreview || info.title || "Codex session",
      createdAt: info.createdAt,
      lastActive: info.lastActive,
      tracked: trackedMap.has(id),
      backend: "codex",
    }];
  });
}

/** On startup, close out any tool_calls that never got a result (e.g. server crashed mid-query) */
export function cleanupPendingToolCalls(): void {
  ensureHistoryDir();
  if (!fs.existsSync(HISTORY_DIR)) return;

  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const sessionId = file.replace(/\.json$/, "");
    let entries: HistoryEntry[];
    try {
      entries = readHistoryEntries(sessionId);
    } catch {
      continue;
    }

    // Collect all tool_use_ids that have results
    const resultIds = new Set(
      entries
        .filter((e) => e.role === "tool_result" && e.toolUseId)
        .map((e) => e.toolUseId!)
    );

    // Add empty results for any tool_calls missing them
    let modified = false;
    for (const entry of entries) {
      if (entry.role === "tool_call" && entry.toolUseId && !resultIds.has(entry.toolUseId)) {
        entries.push({
          role: "tool_result",
          content: "",
          toolUseId: entry.toolUseId,
          toolOutput: "",
          timestamp: new Date().toISOString(),
        });
        modified = true;
      }
    }

    if (modified) {
      writeHistoryEntries(sessionId, entries);
      console.log(`Cleaned up pending tool calls in ${file}`);
    }
  }
}

// ── SDK session discovery ──

export interface SdkSessionEntry {
  sessionId: string;
  firstMessage: string;
  createdAt: string;
  lastActive: string;
  tracked: boolean; // true if already in SocketAgent store
  backend?: "claude" | "codex"; // absent on legacy entries; treat as claude
}

/**
 * Build a map of sessionId → last user prompt from ~/.claude/history.jsonl.
 * This file stores every prompt the user sent, with `display`, `sessionId`, and `project`.
 */
function loadPromptHistory(cwd: string): Map<string, string> {
  const homeDir = process.env.HOME || require("os").homedir();
  const historyPath = path.join(homeDir, ".claude", "history.jsonl");
  const map = new Map<string, string>();
  if (!fs.existsSync(historyPath)) return map;

  try {
    const lines = fs.readFileSync(historyPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      // Match sessions for this project (CWD)
      if (obj.project === cwd && obj.sessionId && obj.display) {
        map.set(obj.sessionId, obj.display); // last prompt wins
      }
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * List Claude Code SDK sessions for a given CWD.
 * Scans ~/.claude/projects/-{cwd-sanitized}/ for JSONL files.
 * Uses ~/.claude/history.jsonl for session preview text.
 * Includes both tracked (already in SocketAgent store) and untracked sessions.
 */
export function listSdkSessions(cwd: string, limit = 30): SdkSessionEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const projectDir = sanitizeCwdToProjectDir(cwd);
  const projectPath = path.join(homeDir, ".claude", "projects", projectDir);

  if (!fs.existsSync(projectPath)) return [];

  let files: string[];
  try {
    // Filter out agent-* files (subagent sessions — not independently resumable)
    files = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  } catch {
    return [];
  }

  // Build lookup of tracked sessions for this CWD
  const store = readStore();
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of store) {
    if (s.cwd === cwd) trackedMap.set(s.id, s);
  }

  // Load prompt history from ~/.claude/history.jsonl
  const promptHistory = loadPromptHistory(cwd);

  // Sort by mtime, scan more files than the limit since some will be skipped as stubs
  const scanLimit = limit * 5;
  const fileStats = files
    .map(f => {
      try {
        const mtime = fs.statSync(path.join(projectPath, f)).mtimeMs;
        return { file: f, mtime };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b!.mtime - a!.mtime)
    .slice(0, scanLimit) as { file: string; mtime: number }[];

  const results: SdkSessionEntry[] = [];

  for (const { file, mtime } of fileStats) {
    const sessionId = file.replace(".jsonl", "");
    const tracked = trackedMap.get(sessionId);

    // For tracked sessions, use stored preview instead of parsing JSONL
    if (tracked) {
      results.push({
        sessionId,
        firstMessage: tracked.messagePreview || tracked.title || "Untitled",
        createdAt: tracked.createdAt,
        lastActive: tracked.lastActive,
        tracked: true,
        backend: "claude",
      });
      continue;
    }

    // Use prompt history for the preview (last user prompt for this session)
    const promptPreview = promptHistory.get(sessionId);
    if (promptPreview) {
      results.push({
        sessionId,
        firstMessage: promptPreview.slice(0, 200),
        createdAt: new Date(mtime).toISOString(),
        lastActive: new Date(mtime).toISOString(),
        tracked: false,
        backend: "claude",
      });
      continue;
    }

    // Fallback: parse the JSONL for the first real (non-Warmup) user message
    const filePath = path.join(projectPath, file);
    let userMessage = "";

    try {
      const stat = fs.statSync(filePath);
      // Read up to 256KB from the head — the real prompt is usually near the start
      const readSize = Math.min(256 * 1024, stat.size);
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      fs.closeSync(fd);

      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.type === "user" && obj.message?.content) {
          const content = obj.message.content;
          let text = "";
          if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === "text");
            if (textBlock?.text) text = textBlock.text;
          } else if (typeof content === "string") {
            text = content;
          }
          // Skip warmup/internal messages, keep looking
          if (text && !/^\s*Warmup\s*$/i.test(text)) {
            userMessage = text.slice(0, 200);
            break;
          }
        }
      }
    } catch { /* ignore */ }

    // Skip sessions with no discoverable user message (true stubs)
    if (!userMessage) continue;

    results.push({
      sessionId,
      firstMessage: userMessage,
      createdAt: new Date(mtime).toISOString(),
      lastActive: new Date(mtime).toISOString(),
      tracked: false,
      backend: "claude",
    });

    // Stop once we have enough results
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Read the first line of a (potentially huge) file synchronously, growing the
 * buffer as needed. Caps at 1 MB to avoid pathological cases. Returns null on
 * read errors or if no newline appears within the cap.
 */
function readFirstLineSync(filePath: string): string | null {
  let fd: number;
  try { fd = fs.openSync(filePath, "r"); } catch { return null; }
  try {
    let buf = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
      const nl = buf.indexOf(0x0a); // '\n'
      if (nl >= 0) return buf.subarray(0, nl).toString("utf8");
      pos += bytesRead;
      if (buf.length > 1024 * 1024) break;
    }
  } catch {
    /* fall through */
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Locate a codex rollout file by thread id. Walks ~/.codex/sessions/ and
 * returns the first path whose filename ends with `-<sessionId>.jsonl`.
 * Returns null if not found.
 */
export function findCodexRolloutFile(sessionId: string): string | null {
  const indexedPath = findCodexRolloutPathFromStateDb(sessionId);
  if (indexedPath) return indexedPath;

  const homeDir = process.env.HOME || require("os").homedir();
  const roots = [
    path.join(homeDir, ".codex", "sessions"),
    path.join(homeDir, ".codex", "archived_sessions"),
  ].filter((dir) => fs.existsSync(dir));
  if (roots.length === 0) return null;

  const suffix = `-${sessionId}.jsonl`;
  let found: string | null = null;
  function walk(dir: string): void {
    if (found) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const p = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.isDirectory()) {
        walk(p);
      } else if (entry.endsWith(suffix)) {
        found = p;
        return;
      }
    }
  }
  for (const root of roots) {
    walk(root);
    if (found) break;
  }
  return found;
}

function archiveCodexNativeRollout(sessionId: string, rolloutPath: string): string {
  const homeDir = process.env.HOME || require("os").homedir();
  const archiveDir = path.join(homeDir, ".codex", "archived_sessions");
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const archivedPath = path.join(archiveDir, path.basename(rolloutPath));
  let finalPath = rolloutPath;
  const alreadyArchived = path.resolve(path.dirname(rolloutPath)) === path.resolve(archiveDir);
  if (!alreadyArchived && fs.existsSync(rolloutPath)) {
    if (fs.existsSync(archivedPath)) fs.unlinkSync(archivedPath);
    fs.renameSync(rolloutPath, archivedPath);
    finalPath = archivedPath;
  }
  updateCodexThreadRolloutState(sessionId, finalPath, true);
  return finalPath;
}

function updateCodexThreadRolloutState(sessionId: string, rolloutPath: string, archived: boolean): void {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return;
  const archivedAt = archived ? String(Math.floor(Date.now() / 1000)) : "NULL";
  const sql = `
    UPDATE threads
    SET rollout_path = ${sqlStringLiteral(rolloutPath)},
        archived = ${archived ? 1 : 0},
        archived_at = ${archivedAt}
    WHERE id = ${sqlStringLiteral(sessionId)};
  `;
  try {
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to update Codex thread state for ${sessionId}: ${err?.message || String(err)}`);
  }
}

function findCodexRolloutPathFromStateDb(sessionId: string): string | null {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const sql = `SELECT rollout_path FROM threads WHERE id = ${sqlStringLiteral(sessionId)} LIMIT 1;`;
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    }).trim();
    if (!raw) return null;
    const rows = JSON.parse(raw) as Array<{ rollout_path?: string }>;
    const rolloutPath = rows[0]?.rollout_path;
    return rolloutPath && fs.existsSync(rolloutPath) ? rolloutPath : null;
  } catch {
    return null;
  }
}

export function isCodexThreadArchived(sessionId: string): boolean {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  const sql = `SELECT archived FROM threads WHERE id = ${sqlStringLiteral(sessionId)} LIMIT 1;`;
  try {
    const raw = execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    }).trim();
    return raw === "1";
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to read archived state for ${sessionId}: ${err?.message || String(err)}`);
    return false;
  }
}

export function getCodexThreadSessionInfo(sessionId: string): SessionInfo | null {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const sql = `
    SELECT
      id,
      title,
      first_user_message,
      preview,
      cwd,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms
    FROM threads
    WHERE id = ${sqlStringLiteral(sessionId)}
    LIMIT 1;
  `;
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    }).trim();
    if (!raw) return null;
    const row = JSON.parse(raw)[0];
    if (!row?.id || !row?.cwd) return null;
    const createdAt = epochToIso(row.created_at_ms ?? row.created_at, nowIso());
    const lastActive = epochToIso(row.updated_at_ms ?? row.updated_at, createdAt);
    const preview = String(row.preview || row.first_user_message || "");
    const title = String(row.title || preview.split(/\r?\n/)[0] || "Codex session");
    return {
      id: String(row.id),
      title: title.length > 80 ? title.slice(0, 80) + "…" : title,
      cwd: String(row.cwd),
      createdAt,
      lastActive,
      messagePreview: preview.slice(0, 200),
      turnCount: conversationTurnCountForSession(String(row.id)),
      backend: "codex",
      codexDriver: "app-server",
    } as SessionInfo;
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to read thread metadata for ${sessionId}: ${err?.message || String(err)}`);
    return null;
  }
}

function listCodexNativeArchives(limit = 200): ArchiveEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return [];
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const sql = `
    SELECT
      id,
      title,
      first_user_message,
      preview,
      cwd,
      archived_at,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms
    FROM threads
    WHERE archived = 1
    ORDER BY COALESCE(archived_at, updated_at) DESC, id DESC
    LIMIT ${safeLimit};
  `;
  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).trim();
    if (!raw) return [];
    const rows = JSON.parse(raw) as any[];
    return rows.flatMap((row): ArchiveEntry[] => {
      const sessionId = String(row.id || "");
      if (!sessionId) return [];
      const createdAt = epochToIso(row.created_at_ms ?? row.created_at, nowIso());
      const clearedAt = epochToIso(row.archived_at ?? row.updated_at_ms ?? row.updated_at, createdAt);
      const preview = String(row.preview || row.first_user_message || "");
      const title = String(row.title || preview.split(/\r?\n/)[0] || "Codex session");
      return [{
        sid: sessionId,
        ts: `${CODEX_NATIVE_ARCHIVE_TS_PREFIX}${row.archived_at ?? row.updated_at ?? Date.now()}`,
        title: title.length > 80 ? title.slice(0, 80) + "…" : title,
        cwd: String(row.cwd || ""),
        backend: "codex",
        createdAt,
        clearedAt,
        messagePreview: preview.slice(0, 200),
        messageCount: 0,
        hasJsonl: true,
      }];
    });
  } catch (err: any) {
    console.warn(`[CodexArchive] failed to list native Codex archives: ${err?.message || String(err)}`);
    return [];
  }
}

function buildCodexRolloutRestorePath(sessionId: string, archivePath: string): string | null {
  let timestamp = "";
  try {
    const firstLine = fs.readFileSync(archivePath, "utf-8").split("\n", 1)[0];
    if (firstLine) {
      const obj = JSON.parse(firstLine);
      if (typeof obj?.payload?.timestamp === "string") timestamp = obj.payload.timestamp;
    }
  } catch {}

  const d = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const stamp = d.toISOString().slice(0, 19).replace(/:/g, "-");
  const homeDir = process.env.HOME || require("os").homedir();
  return path.join(homeDir, ".codex", "sessions", year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
}

/**
 * Read a codex rollout file and translate it into SocketAgent HistoryEntry
 * items. Used to backfill chat history when resuming a codex session that
 * we don't already have local history for (e.g., one created via the codex
 * CLI directly, or before this session's machine ran the SocketAgent
 * server).
 *
 * Mapping:
 *   - event_msg user_message            → role: "user" (canonical user input,
 *     skipping the response_item duplicates that include AGENTS.md/permissions
 *     boilerplate codex injects on each turn)
 *   - response_item message role=assistant → role: "assistant"
 *   - response_item function_call       → role: "tool_call" (exec_command is
 *     re-labelled as "Bash" so the existing tool-call rendering picks it up)
 *   - response_item function_call_output → role: "tool_result"
 *   - everything else (session_meta, turn_context, reasoning items,
 *     event_msg token_count/task_started/etc.) → skipped
 */
export function readCodexRolloutHistory(sessionId: string): HistoryEntry[] {
  const file = findCodexRolloutFile(sessionId);
  if (!file) return [];

  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return codexRolloutJsonlToHistory(raw, { threadId: sessionId });
}

export async function readCodexAppServerThreadHistory(sessionId: string): Promise<HistoryEntry[]> {
  const client = new CodexAppServerClient({
    cwd: process.cwd(),
    env: process.env,
    requestTimeoutMs: 15_000,
    startupTimeoutMs: 15_000,
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
    const response = await client.readThread({ threadId: sessionId, includeTurns: true });
    return codexAppServerThreadToHistory((response as any)?.thread);
  } catch (err: any) {
    console.warn(`[CodexHistory] app-server thread/read failed for ${sessionId}: ${err?.message || String(err)}`);
    return [];
  } finally {
    await client.stop().catch(() => {});
  }
}

export interface CodexRolloutContextUsage {
  totalTokens: number;
  maxTokens: number;
  model?: string;
  categories: Array<{ name: string; tokens: number; color: string }>;
  source: "codex_rollout";
  lastTokenUsage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  };
  totalTokenUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  };
  rateLimits?: any;
}

/**
 * Read the latest Codex token_count event for a thread. There is no public
 * `codex status <thread>` CLI surface today, but rollout files include
 * model_context_window and per-turn token usage after each turn.
 */
export function readCodexRolloutContextUsage(sessionId: string): CodexRolloutContextUsage | null {
  const file = findCodexRolloutFile(sessionId);
  if (!file) return null;

  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }

  let latestInfo: any = null;
  let latestRateLimits: any = null;
  let latestModel: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    const payload = obj.payload;
    if (!payload || typeof payload !== "object") continue;

    if (obj.type === "turn_context" && typeof payload.model === "string") {
      latestModel = payload.model;
      continue;
    }

    if (obj.type === "event_msg" && payload.type === "token_count" && payload.info) {
      latestInfo = payload.info;
      latestRateLimits = payload.rate_limits;
    }
  }

  const last = latestInfo?.last_token_usage;
  const maxTokens = Number(latestInfo?.model_context_window ?? 0);
  const inputTokens = Number(last?.input_tokens ?? 0);
  if (!last || inputTokens <= 0 || maxTokens <= 0) return null;

  const cached = Number(last.cached_input_tokens ?? 0);
  const uncached = Math.max(0, inputTokens - cached);
  const categories = [
    ...(cached > 0 ? [{ name: "Cached input", tokens: cached, color: "#89B4FA" }] : []),
    ...(uncached > 0 ? [{ name: "Uncached input", tokens: uncached, color: "#F9E2AF" }] : []),
  ];

  return {
    totalTokens: inputTokens,
    maxTokens,
    ...(latestModel ? { model: latestModel } : {}),
    categories,
    source: "codex_rollout",
    lastTokenUsage: {
      input_tokens: inputTokens,
      cached_input_tokens: cached,
      output_tokens: Number(last.output_tokens ?? 0),
      reasoning_output_tokens: Number(last.reasoning_output_tokens ?? 0),
      total_tokens: Number(last.total_tokens ?? 0),
    },
    ...(latestInfo.total_token_usage ? {
      totalTokenUsage: {
        input_tokens: Number(latestInfo.total_token_usage.input_tokens ?? 0),
        cached_input_tokens: Number(latestInfo.total_token_usage.cached_input_tokens ?? 0),
        output_tokens: Number(latestInfo.total_token_usage.output_tokens ?? 0),
        reasoning_output_tokens: Number(latestInfo.total_token_usage.reasoning_output_tokens ?? 0),
        total_tokens: Number(latestInfo.total_token_usage.total_tokens ?? 0),
      },
    } : {}),
    ...(latestRateLimits ? { rateLimits: latestRateLimits } : {}),
  };
}

function cwdLookupCandidates(cwd: string): Set<string> {
  const candidates = new Set<string>();
  const add = (p: string) => {
    if (!p) return;
    candidates.add(path.resolve(p));
    candidates.add(path.resolve(p).replace(/\/+$/, ""));
  };
  add(cwd);
  try { add(fs.realpathSync(cwd)); } catch {}
  try { add(fs.realpathSync.native(cwd)); } catch {}
  return candidates;
}

function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function epochToIso(value: unknown, fallback: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function listCodexSessionsFromStateDb(cwdCandidates: Set<string>, limit: number, trackedMap: Map<string, SessionInfo>): SdkSessionEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const dbPath = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fs.existsSync(dbPath) || cwdCandidates.size === 0) return [];

  const cwdList = [...cwdCandidates].map(sqlStringLiteral).join(", ");
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const sql = `
    SELECT
      id,
      title,
      first_user_message,
      preview,
      rollout_path,
      archived,
      created_at,
      updated_at,
      created_at_ms,
      updated_at_ms
    FROM threads
    WHERE archived = 0 AND cwd IN (${cwdList})
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC
    LIMIT ${safeLimit};
  `;

  try {
    const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).trim();
    if (!raw) return [];
    const rows = JSON.parse(raw) as any[];
    const results: SdkSessionEntry[] = [];
    for (const row of rows) {
      const sessionId = String(row.id || "");
      if (!sessionId) continue;
      const rolloutPath = findCodexRolloutFile(sessionId);
      if (!rolloutPath) continue;
      const tracked = trackedMap.get(sessionId);
      const createdAt = epochToIso(row.created_at_ms ?? row.created_at, nowIso());
      const lastActive = tracked?.lastActive || epochToIso(row.updated_at_ms ?? row.updated_at, createdAt);
      const firstMessage =
        tracked?.messagePreview ||
        tracked?.title ||
        String(row.preview || row.first_user_message || row.title || "Codex session");
      results.push({
        sessionId,
        firstMessage,
        createdAt,
        lastActive,
        tracked: !!tracked,
        backend: "codex",
      });
    }
    return results;
  } catch (err: any) {
    console.warn(`[CodexSessions] state DB lookup failed: ${err?.message || String(err)}`);
    return [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * List Codex sessions for a given CWD. Prefer Codex's SQLite thread index
 * (`~/.codex/state_5.sqlite`), which is the modern app-server/CLI source of
 * truth. Fall back to scanning rollout JSONL files for older installs.
 */
export function listCodexSessions(cwd: string, limit = 30): SdkSessionEntry[] {
  const homeDir = process.env.HOME || require("os").homedir();
  const sessionsDir = path.join(homeDir, ".codex", "sessions");
  const cwdCandidates = cwdLookupCandidates(cwd);

  const store = readStore();
  const trackedMap = new Map<string, SessionInfo>();
  for (const s of store) {
    if (s.backend === "codex" && setsIntersect(cwdLookupCandidates(s.cwd), cwdCandidates)) {
      trackedMap.set(s.id, s);
    }
  }

  const stateDbSessions = listCodexSessionsFromStateDb(cwdCandidates, limit, trackedMap);
  if (stateDbSessions.length > 0) return stateDbSessions;
  if (!fs.existsSync(sessionsDir)) return [];

  // Walk the date-partitioned tree to gather candidate rollout files.
  const candidates: { filePath: string; mtimeMs: number }[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.isDirectory()) {
        walk(p);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        candidates.push({ filePath: p, mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(sessionsDir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const results: SdkSessionEntry[] = [];
  for (const { filePath, mtimeMs } of candidates) {
    const firstLine = readFirstLineSync(filePath);
    if (!firstLine) continue;

    let meta: any;
    try { meta = JSON.parse(firstLine); } catch { continue; }
    if (meta?.type !== "session_meta" || !meta.payload) continue;
    if (!cwdCandidates.has(path.resolve(String(meta.payload.cwd || "")).replace(/\/+$/, ""))) continue;

    const sessionId = meta.payload.id as string | undefined;
    if (!sessionId) continue;
    const timestamp = (meta.payload.timestamp as string | undefined) || new Date(mtimeMs).toISOString();
    const tracked = trackedMap.get(sessionId);

    let firstMessage = "Codex session";
    if (tracked) {
      firstMessage = tracked.messagePreview || tracked.title || firstMessage;
    }

    results.push({
      sessionId,
      firstMessage,
      createdAt: timestamp,
      lastActive: tracked?.lastActive || new Date(mtimeMs).toISOString(),
      tracked: !!tracked,
      backend: "codex",
    });

    if (results.length >= limit) break;
  }

  return results;
}
