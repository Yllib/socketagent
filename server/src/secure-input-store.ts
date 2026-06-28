import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ServerMessage } from "./protocol";

export type SecureInputScope = "session" | "project" | "global";

export interface SecureInputRequestArgs {
  label: string;
  reason?: string;
  envHint?: string;
  scope?: SecureInputScope;
  multiline?: boolean;
  timeoutSeconds?: number;
}

export interface SecureInputSaveArgs extends SecureInputRequestArgs {
  value: string;
  sessionId?: string;
  cwd?: string;
}

export interface SavedSecureInput {
  secretId: string;
  label: string;
  scope: SecureInputScope;
  filePath: string;
  metadataPath: string;
  envHint: string;
  sessionId?: string;
  cwd?: string;
  createdAt: string;
}

interface PendingSecureInput {
  requestId: string;
  args: SecureInputRequestArgs;
  sessionId?: string;
  cwd?: string;
  resolve: (value: SavedSecureInput) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const STORE_DIR = path.join(os.homedir(), ".claude-assistant", "secrets");
const pendingRequests = new Map<string, PendingSecureInput>();
const secretValues = new Set<string>();
let loadedExistingSecrets = false;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function contextSegment(scope: SecureInputScope, sessionId?: string, cwd?: string): string {
  if (scope === "global") return "global";
  if (scope === "session") return sanitizeSegment(sessionId || "pending", "pending");
  const hash = crypto.createHash("sha256").update(cwd || process.cwd()).digest("hex").slice(0, 16);
  return sanitizeSegment(`${path.basename(cwd || "project")}_${hash}`, `project_${hash}`);
}

function normalizeScope(value: unknown): SecureInputScope {
  return value === "project" || value === "global" ? value : "session";
}

function normalizeEnvHint(label: string, envHint?: string): string {
  const raw = (envHint || label || "SECRET").trim();
  const normalized = raw
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || "SOCKETAGENT_SECRET";
}

function registerSecretValue(value: string): void {
  if (value.length >= 4) secretValues.add(value);
}

function loadExistingSecretsForRedaction(): void {
  if (loadedExistingSecrets) return;
  loadedExistingSecrets = true;
  try {
    if (!fs.existsSync(STORE_DIR)) return;
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          walk(filePath);
        } else if (!filePath.endsWith(".json") && stat.size > 0 && stat.size < 1024 * 1024) {
          registerSecretValue(fs.readFileSync(filePath, "utf8"));
        }
      }
    };
    walk(STORE_DIR);
  } catch (err: any) {
    console.warn(`[secure-input] Failed to load existing secrets for redaction: ${err?.message || err}`);
  }
}

export function redactSecrets(text: string): string {
  loadExistingSecretsForRedaction();
  let redacted = text;
  const values = [...secretValues].sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (!value || value.length < 4) continue;
    redacted = redacted.split(value).join("[secure-input:redacted]");
  }
  return redacted;
}

export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(item);
    }
    return out as T;
  }
  return value;
}

export function saveSecureInput(args: SecureInputSaveArgs): SavedSecureInput {
  const label = args.label?.trim() || "Secret";
  const scope = normalizeScope(args.scope);
  const secretId = `sec_${crypto.randomBytes(8).toString("hex")}`;
  const scopeDir = path.join(STORE_DIR, scope, contextSegment(scope, args.sessionId, args.cwd));
  ensureDir(STORE_DIR);
  ensureDir(path.join(STORE_DIR, scope));
  ensureDir(scopeDir);

  const fileBase = `${sanitizeSegment(label, "secret")}_${secretId}`;
  const filePath = path.join(scopeDir, fileBase);
  const metadataPath = `${filePath}.json`;
  const createdAt = new Date().toISOString();
  const envHint = normalizeEnvHint(label, args.envHint);

  fs.writeFileSync(filePath, args.value, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}

  const saved: SavedSecureInput = {
    secretId,
    label,
    scope,
    filePath,
    metadataPath,
    envHint,
    createdAt,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  };
  fs.writeFileSync(metadataPath, JSON.stringify({ ...saved, valueRedacted: true }, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(metadataPath, 0o600); } catch {}
  registerSecretValue(args.value);
  return saved;
}

export function requestSecureInput(
  send: (msg: ServerMessage | Record<string, unknown>) => void,
  args: SecureInputRequestArgs,
  sessionId?: string,
  cwd?: string,
): Promise<SavedSecureInput> {
  const requestId = `secure_${crypto.randomBytes(8).toString("hex")}`;
  const timeoutMs = Math.max(30, Math.min(args.timeoutSeconds ?? 600, 3600)) * 1000;
  const promise = new Promise<SavedSecureInput>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Timed out waiting for secure input"));
    }, timeoutMs);
    pendingRequests.set(requestId, { requestId, args, sessionId, cwd, resolve, reject, timer });
  });

  send({
    type: "secure_input_request",
    requestId,
    sessionId: sessionId || "",
    label: args.label || "Secret",
    reason: args.reason || "",
    envHint: normalizeEnvHint(args.label || "Secret", args.envHint),
    scope: normalizeScope(args.scope),
    multiline: args.multiline === true,
  });

  return promise;
}

export function completeSecureInputRequest(requestId: string, value: string): SavedSecureInput {
  const pending = pendingRequests.get(requestId);
  if (!pending) throw new Error("Secure input request is no longer pending");
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);
  const saved = saveSecureInput({
    ...pending.args,
    value,
    sessionId: pending.sessionId,
    cwd: pending.cwd,
  });
  pending.resolve(saved);
  return saved;
}

export function cancelSecureInputRequest(requestId: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);
  pending.reject(new Error("User cancelled secure input"));
}

export function pendingSecureInputMessagesForSession(sessionId: string): Array<ServerMessage | Record<string, unknown>> {
  if (!sessionId) return [];
  const messages: Array<ServerMessage | Record<string, unknown>> = [];
  for (const pending of pendingRequests.values()) {
    if (pending.sessionId !== sessionId) continue;
    messages.push({
      type: "secure_input_request",
      requestId: pending.requestId,
      sessionId,
      label: pending.args.label || "Secret",
      reason: pending.args.reason || "",
      envHint: normalizeEnvHint(pending.args.label || "Secret", pending.args.envHint),
      scope: normalizeScope(pending.args.scope),
      multiline: pending.args.multiline === true,
    });
  }
  return messages;
}
