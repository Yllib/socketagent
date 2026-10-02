import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import { z } from "zod";
import type { Backend, HistoryEntry, SessionInfo } from "./protocol";
import { historyEntrySchema } from "./history-schema";
import {
  adoptWrittenHistory,
  deleteSessionArtifacts,
  getHistoryCount,
  getJsonlPath,
  getSdkEvents,
  getSession,
  listSessions,
  getTodos,
  replaceSdkEvents,
  saveSession,
  saveTodos,
  writePreparedHistoryBatch,
} from "./session-store";
import {
  deleteHtmlPlansForSession,
  exportHtmlPlansForSession,
  importHtmlPlansForSession,
} from "./html-plan-store";
import { socketAgentDataPath } from "./socket-agent-paths";
import { MAX_TRANSFER_BUNDLE_BYTES } from "./session-transfer-jobs";
import {
  TRANSFER_SCHEMA,
  TRANSFER_VERSION,
  readBundleHeader,
  type BundleHeader,
  type TranscriptMode,
} from "./session-transfer-bundle";
import type { TransferWorkerTask } from "./session-transfer-worker";

export type { TranscriptMode } from "./session-transfer-bundle";

const TRANSFER_DIR = socketAgentDataPath("session-transfers");
/** A runaway worker fails its transfer instead of taking the server's memory with it. */
const WORKER_HEAP_MB = 1536;

export interface SessionTransferExportOptions {
  transcript: TranscriptMode;
  /** Include the native Claude JSONL. Only exact Claude-to-Claude moves use it. */
  includeNative: boolean;
}

export interface SessionTransferExportResult {
  bundlePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  bundleId: string;
  sessionId: string;
  backend: Backend;
  cwd: string;
  exactNativeAvailable: boolean;
}

export interface SessionTransferEstimate {
  /** Uncompressed transcript bytes with every tool output. */
  fullBytes: number;
  /** Uncompressed transcript bytes with large tool outputs cut to their stored preview. */
  truncatedBytes: number;
}

export interface SessionTransferImportOptions {
  bundlePath: string;
  expectedSha256: string;
  targetCwd: string;
  targetBackend: Backend;
  mode: "move" | "clone";
  nativeMode: "exact" | "handoff";
  /** Durable server jobs retain their bundle and reuse the same import identity. */
  transferId?: string;
  /** Called after each batch of history entries is written, against the source's entry count. */
  onProgress?: (restored: number, total: number) => void;
}

export interface SessionTransferImportResult {
  session: SessionInfo;
  sourceSessionId: string;
  exactNativeResume: boolean;
}

const estimateResultSchema = z.object({ storedBytes: z.number(), spilledBytes: z.number() });
const exportResultSchema = z.object({ fileSize: z.number(), sha256: z.string() });
const importResultSchema = z.object({ sdkEvents: z.array(z.record(z.string(), z.unknown())) });

const workerMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("batch"), entries: z.array(historyEntrySchema) }),
  z.object({ kind: z.literal("result"), result: z.unknown() }),
]);

/**
 * Runs one step in session-transfer-worker and resolves with its result. An
 * import hands prepared history to onBatch, and the worker waits for each batch
 * to be written, so it never runs ahead of the database.
 */
function runTransferWorker(
  task: TransferWorkerTask,
  onBatch?: (entries: HistoryEntry[]) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "session-transfer-worker.js"), {
      workerData: task,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
      void worker.terminate();
    };
    worker.on("message", (raw: unknown) => {
      try {
        const message = workerMessageSchema.parse(raw);
        if (message.kind === "result") {
          settled = true;
          resolve(message.result);
          return;
        }
        if (!onBatch) throw new Error("The transfer worker sent history to a step that does not write any");
        onBatch(message.entries);
        worker.postMessage("written");
      } catch (error) {
        fail(error);
      }
    });
    worker.once("error", fail);
    worker.once("exit", (code) => fail(new Error(`Session transfer worker exited with code ${code}`)));
  });
}

function ensureTransferDir(): void {
  fs.mkdirSync(TRANSFER_DIR, { recursive: true, mode: 0o700 });
}

/** Internal export bundles remain downloadable even when file-manager roots are restricted. */
export function isSessionTransferPath(filePath: string): boolean {
  const relative = path.relative(TRANSFER_DIR, path.resolve(filePath));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cleanOldTransfers(): void {
  ensureTransferDir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(TRANSFER_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(TRANSFER_DIR, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {}
  }
}

/** Sizes the transcript both ways from stored rows, without reading any spilled output. */
export async function estimateSessionTransfer(sessionId: string): Promise<SessionTransferEstimate> {
  if (!getSession(sessionId)) throw new Error("Session not found");
  getHistoryCount(sessionId); // Moves a legacy JSON transcript into the database first.
  const size = estimateResultSchema.parse(await runTransferWorker({ op: "estimate", sessionId }));
  return { fullBytes: size.storedBytes + size.spilledBytes, truncatedBytes: size.storedBytes };
}

export async function exportSessionTransfer(
  sessionId: string,
  options: SessionTransferExportOptions = { transcript: "full", includeNative: true },
): Promise<SessionTransferExportResult> {
  cleanOldTransfers();
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");
  getHistoryCount(sessionId); // Moves a legacy JSON transcript into the database first.
  const backend = session.backend || "claude";
  const nativePath = options.includeNative && backend === "claude"
    ? getJsonlPath(sessionId, session.cwd)
    : undefined;
  const native = !!nativePath && fs.existsSync(nativePath) && fs.statSync(nativePath).isFile();
  const header: BundleHeader = {
    kind: "header",
    schema: TRANSFER_SCHEMA,
    version: TRANSFER_VERSION,
    bundleId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source: {
      serverLabel: os.hostname(),
      sessionId,
      backend,
      cwd: session.cwd,
    },
    session: {
      ...session,
      backend,
      running: false,
      activeStartedAt: undefined,
      pendingHandoffContext: undefined,
    },
    todos: getTodos(sessionId),
    htmlPlans: exportHtmlPlansForSession(sessionId),
    handoffContext: "",
    transcript: options.transcript,
    native,
  };
  const fileName = `socketagent-session-${sessionId}-${header.bundleId}.satransfer`;
  const bundlePath = path.join(TRANSFER_DIR, fileName);
  const temporary = `${bundlePath}.${process.pid}.tmp`;
  const written = exportResultSchema.parse(await runTransferWorker({
    op: "export",
    sessionId,
    bundlePath: temporary,
    header,
    sdkEvents: getSdkEvents(sessionId, 100_000),
    ...(native ? { nativePath } : {}),
  }));
  fs.renameSync(temporary, bundlePath);
  return {
    bundlePath,
    fileName,
    fileSize: written.fileSize,
    sha256: written.sha256,
    bundleId: header.bundleId,
    sessionId,
    backend,
    cwd: session.cwd,
    exactNativeAvailable: native,
  };
}

function destinationAgentSettings(
  source: SessionInfo,
  targetBackend: Backend,
): SessionInfo["agentSettings"] {
  const settings = { ...(source.agentSettings || {}) };
  if ((source.backend || "claude") !== targetBackend) {
    delete settings.model;
  }
  if (targetBackend === "codex") {
    delete settings.thinking;
    delete settings.claudeAutoCompact;
    delete settings.claudeAutoCompactWindow;
  } else {
    delete settings.codexFastMode;
    delete settings.codexCollaborationMode;
  }
  return settings;
}

export async function importSessionTransfer(
  options: SessionTransferImportOptions,
): Promise<SessionTransferImportResult> {
  try {
    return await importBundle(options);
  } finally {
    if (!options.transferId) {
      try { fs.rmSync(options.bundlePath, { force: true }); } catch {}
    }
  }
}

async function importBundle(options: SessionTransferImportOptions): Promise<SessionTransferImportResult> {
  const targetCwd = path.resolve(options.targetCwd);
  const cwdStat = fs.statSync(targetCwd);
  if (!cwdStat.isDirectory()) throw new Error(`Destination is not a directory: ${targetCwd}`);
  if (fs.statSync(options.bundlePath).size > MAX_TRANSFER_BUNDLE_BYTES) {
    throw new Error("Session bundle exceeds the transfer limit");
  }
  // The worker verifies the checksum before it writes anything.
  const header = await readBundleHeader(options.bundlePath);
  const sourceBackend = header.source.backend;
  const exactNativeResume = options.nativeMode === "exact"
    && options.mode === "move"
    && sourceBackend === "claude"
    && options.targetBackend === "claude"
    && header.native;
  if (options.nativeMode === "exact" && !exactNativeResume) {
    throw new Error("Exact native transfer is available only for Claude-to-Claude moves");
  }

  const sessionId = exactNativeResume ? header.source.sessionId : options.transferId || crypto.randomUUID();
  const existing = (options.transferId
    ? listSessions().find(session => session.transferLineage?.transferId === options.transferId)
    : undefined) || getSession(sessionId);
  if (options.transferId && existing?.transferLineage?.transferId === options.transferId) {
    return { session: existing, sourceSessionId: header.source.sessionId, exactNativeResume };
  }
  if (existing) throw new Error(`Destination already has session ${sessionId}`);
  const nativePath = exactNativeResume ? getJsonlPath(sessionId, targetCwd) : undefined;
  // The intent permits recovery of a partially written import after a process exit.
  const intentPath = options.transferId ? `${options.bundlePath}.import.json` : undefined;
  const intent = JSON.stringify({ sessionId, sha256: options.expectedSha256, targetCwd });
  const recovering = intentPath && fs.existsSync(intentPath)
    && fs.readFileSync(intentPath, "utf8") === intent;
  if (nativePath && fs.existsSync(nativePath) && !recovering) {
    throw new Error(`Destination already has the native Claude session ${sessionId}`);
  }

  const now = new Date().toISOString();
  const imported: SessionInfo = {
    ...header.session,
    id: sessionId,
    title: options.mode === "clone"
      ? `${header.session.title || "Untitled"} (clone)`
      : header.session.title || "Untitled",
    cwd: targetCwd,
    backend: options.targetBackend,
    ...(options.targetBackend === "codex"
      ? { codexDriver: "app-server" as const }
      : { codexDriver: undefined }),
    lastActive: now,
    running: false,
    activeStartedAt: undefined,
    agentSettings: destinationAgentSettings(header.session, options.targetBackend),
    ...(exactNativeResume
      ? { contextClearedAt: undefined, pendingHandoffContext: undefined }
      : { contextClearedAt: now, pendingHandoffContext: header.handoffContext }),
    transferLineage: {
      transferId: options.transferId,
      sourceSessionId: header.source.sessionId,
      sourceBackend,
      sourceServerLabel: header.source.serverLabel,
      transferredAt: now,
      mode: options.mode,
    },
  };

  if (intentPath && !recovering) {
    const fd = fs.openSync(intentPath, "w", 0o600);
    try { fs.writeFileSync(fd, intent); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  try {
    // Start over from whatever an interrupted attempt wrote.
    if (recovering) deleteSessionArtifacts(sessionId, imported);
    if (nativePath) fs.mkdirSync(path.dirname(nativePath), { recursive: true, mode: 0o700 });
    const total = header.session.historyCount || 0;
    let written = 0;
    options.onProgress?.(0, total);
    const restored = importResultSchema.parse(await runTransferWorker({
      op: "import",
      bundlePath: options.bundlePath,
      expectedSha256: options.expectedSha256,
      sessionId,
      ...(nativePath ? { nativePath } : {}),
    }, (entries) => {
      writePreparedHistoryBatch(sessionId, entries);
      written += entries.length;
      options.onProgress?.(Math.min(written, total), total);
    }));
    saveTodos(sessionId, header.todos);
    replaceSdkEvents(sessionId, restored.sdkEvents);
    importHtmlPlansForSession(sessionId, header.htmlPlans);
    saveSession(imported);
    adoptWrittenHistory(sessionId);
    return {
      session: getSession(sessionId) ?? imported,
      sourceSessionId: header.source.sessionId,
      exactNativeResume,
    };
  } catch (error) {
    try { deleteSessionArtifacts(sessionId, imported); } catch {}
    try { deleteHtmlPlansForSession(sessionId); } catch {}
    throw error;
  }
}

export function discardSessionTransfer(bundlePath: string): boolean {
  ensureTransferDir();
  const resolved = path.resolve(bundlePath);
  if (!isSessionTransferPath(resolved)) return false;
  if (!fs.existsSync(resolved)) return true;
  fs.rmSync(resolved, { force: true });
  return true;
}
