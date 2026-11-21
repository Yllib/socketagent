import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveAgyCommand } from "./gemini-cli";
import { socketAgentDataPath } from "./socket-agent-paths";

const execFileAsync = promisify(execFile);

const DEFAULT_CLOUD_CODE_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const REQUEST_TIMEOUT_MS = 5_000;
const TOKEN_REFRESH_TIMEOUT_MS = 5_000;
const EXPIRY_SKEW_MS = 60_000;

const oauthTokenFileSchema = z.object({
  token: z.object({
    access_token: z.string().min(1),
    expiry: z.string().optional(),
  }),
  id_token_email: z.string().optional(),
});

const tierSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
});

const loadCodeAssistResponseSchema = z.object({
  cloudaicompanionProject: z.string().min(1).optional(),
  currentTier: tierSchema.optional(),
  paidTier: tierSchema.optional(),
});

const summaryBucketSchema = z.object({
  bucketId: z.string().optional(),
  displayName: z.string().optional(),
  window: z.string().optional(),
  resetTime: z.string().optional(),
  remainingFraction: z.number().optional(),
});

const summaryGroupSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(summaryBucketSchema).optional(),
});

const quotaSummaryResponseSchema = z.object({
  groups: z.array(summaryGroupSchema).optional(),
  description: z.string().optional(),
});

const modelQuotaBucketSchema = z.object({
  modelId: z.string().optional(),
  tokenType: z.string().optional(),
  remainingFraction: z.number().optional(),
  resetTime: z.string().optional(),
});

const userQuotaResponseSchema = z.object({
  buckets: z.array(modelQuotaBucketSchema).optional(),
});

const geminiQuotaWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string().optional(),
  window: z.string().optional(),
  usedPercent: z.number(),
  remainingFraction: z.number(),
  resetTime: z.string().optional(),
});

const geminiAccountUsageSchema = z.object({
  available: z.boolean(),
  email: z.string().optional(),
  plan: z.string().optional(),
  tier: z.string().optional(),
  windows: z.array(geminiQuotaWindowSchema),
  fetchedAt: z.string(),
});

export type GeminiQuotaWindow = z.infer<typeof geminiQuotaWindowSchema>;
export type GeminiAccountUsage = z.infer<typeof geminiAccountUsageSchema>;

export interface ParseGeminiQuotaInput {
  loadCodeAssist?: unknown;
  summary?: unknown;
  quota?: unknown;
  email?: string;
  fetchedAt?: string;
  model?: string;
}

class CodeAssistHttpError extends Error {
  constructor(
    public readonly status: number,
    rpcPath: string,
  ) {
    super(`Code Assist ${rpcPath} returned HTTP ${status}`);
  }
}

let cachedGeminiUsage: GeminiAccountUsage | null | undefined;
let tokenRefreshInFlight: Promise<boolean> | null = null;

function cacheFilePath(): string {
  return socketAgentDataPath("gemini-plan-usage.json");
}

function rememberGeminiUsage(usage: GeminiAccountUsage): void {
  cachedGeminiUsage = usage;
  try {
    const file = cacheFilePath();
    const tempFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(usage), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, file);
  } catch {
    // Keep the in-memory copy even if disk persistence fails.
  }
}

function loadCachedGeminiUsage(): GeminiAccountUsage | null {
  if (cachedGeminiUsage !== undefined) return cachedGeminiUsage;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"));
    const parsed = geminiAccountUsageSchema.safeParse(raw);
    cachedGeminiUsage = parsed.success ? parsed.data : null;
  } catch {
    cachedGeminiUsage = null;
  }
  return cachedGeminiUsage;
}

/** Resets the in-memory cache so unit tests start clean. */
export function resetGeminiUsageCacheForTests(): void {
  cachedGeminiUsage = undefined;
}

/** Returns the last successfully fetched Gemini quota snapshot, filtered to the active model. */
export function lastGeminiAccountUsage(model?: string): GeminiAccountUsage | null {
  const cached = loadCachedGeminiUsage();
  if (!cached) return null;
  const scoped = selectGeminiUsageForModel(cached, model);
  return scoped.available ? scoped : null;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function usedPercentFromRemaining(remainingFraction: number): number {
  const used = (1 - clampFraction(remainingFraction)) * 100;
  return Math.max(0, Math.min(100, Math.round(used * 10) / 10));
}

function shortenGroupName(displayName: string): string {
  const trimmed = displayName.trim();
  if (/^claude\s+and\s+gpt\s+models$/i.test(trimmed)) return "Claude & GPT";
  return trimmed.replace(/\s+models$/i, "").trim() || trimmed;
}

function formatWindowName(windowName?: string, displayName?: string): string {
  const normalized = (windowName || "").trim().toLowerCase();
  if (normalized === "5h" || normalized === "5hr" || normalized === "session") return "5-hour";
  if (normalized === "weekly" || normalized === "7d" || normalized === "week") return "Weekly";
  if (normalized) return windowName!.trim();
  if (displayName) {
    if (/five\s*hour|5\s*h/i.test(displayName)) return "5-hour";
    if (/week/i.test(displayName)) return "Weekly";
  }
  return "";
}

function windowSortRank(windowName?: string): number {
  const normalized = (windowName || "").trim().toLowerCase();
  if (normalized === "5h" || normalized === "5hr" || normalized === "session") return 0;
  if (normalized === "weekly" || normalized === "7d" || normalized === "week") return 1;
  return 2;
}

function inferWindowFromResetTime(resetTime: string | undefined, fetchedAtIso: string): string {
  if (!resetTime) return "";
  const resetMs = Date.parse(resetTime);
  const fetchedMs = Date.parse(fetchedAtIso);
  if (!Number.isFinite(resetMs) || !Number.isFinite(fetchedMs)) return "";
  const deltaHours = (resetMs - fetchedMs) / (60 * 60 * 1000);
  if (deltaHours > -1 && deltaHours <= 6) return "5-hour";
  if (deltaHours > 24 && deltaHours <= 24 * 8) return "Weekly";
  return "";
}

function poolLabelForGeminiModels(modelIds: string[], index: number, totalPools: number): string {
  if (totalPools <= 1) return "Gemini";
  const lower = modelIds.map((id) => id.toLowerCase());
  const allFlash = lower.every((id) => id.includes("flash"));
  const allPro = lower.every((id) => id.includes("pro") && !id.includes("flash"));
  if (allPro) return "Gemini Pro";
  if (allFlash) return "Gemini Flash";
  return `Gemini #${index + 1}`;
}

function isGeminiWindow(window: GeminiQuotaWindow): boolean {
  return /^gemini/i.test(window.group ?? "") || /^gemini/i.test(window.id);
}

function isThirdPartyModel(model?: string): boolean {
  return typeof model === "string" && /^(claude|gpt)/i.test(model.trim());
}

/**
 * Filters a full Antigravity quota snapshot down to the active model's pool so
 * Gemini sessions only show Gemini limits and 3P Antigravity models only show
 * the Claude & GPT pool.
 */
export function selectGeminiUsageForModel(usage: GeminiAccountUsage, model?: string): GeminiAccountUsage {
  const wantThirdParty = isThirdPartyModel(model);
  const filtered = usage.windows.filter((window) =>
    wantThirdParty ? !isGeminiWindow(window) : isGeminiWindow(window),
  );
  return {
    ...usage,
    windows: filtered,
    available: filtered.length > 0,
  };
}

function geminiWindowLabel(baseLabel: string, windowLabel: string): string {
  if (baseLabel === "Gemini") {
    return windowLabel || "Quota";
  }
  const shortVariant = baseLabel.replace(/^Gemini\s+/i, "");
  return windowLabel ? `${shortVariant} · ${windowLabel}` : baseLabel;
}

/**
 * Normalizes Google Code Assist loadCodeAssist, retrieveUserQuotaSummary, and
 * retrieveUserQuota payloads into compact quota windows for SocketAgent.
 */
export function parseGeminiQuotaUsage(input: ParseGeminiQuotaInput): GeminiAccountUsage {
  const fetchedAt = input.fetchedAt || new Date().toISOString();
  const codeAssist = loadCodeAssistResponseSchema.safeParse(input.loadCodeAssist);
  const summary = quotaSummaryResponseSchema.safeParse(input.summary);
  const quota = userQuotaResponseSchema.safeParse(input.quota);

  const plan = codeAssist.success
    ? (codeAssist.data.paidTier?.name || codeAssist.data.currentTier?.name || undefined)
    : undefined;
  const tier = codeAssist.success ? (codeAssist.data.currentTier?.name || undefined) : undefined;

  const summaryWindows: GeminiQuotaWindow[] = [];
  let summaryCoversGemini = false;

  if (summary.success && summary.data.groups) {
    for (const group of summary.data.groups) {
      const rawGroupName = group.displayName || "";
      const shortGroup = rawGroupName ? shortenGroupName(rawGroupName) : "";
      const buckets = [...(group.buckets ?? [])].sort(
        (a, b) => windowSortRank(a.window) - windowSortRank(b.window),
      );
      const isGeminiGroup = /gemini/i.test(rawGroupName) || buckets.some((b) => /gemini/i.test(b.bucketId || ""));
      if (isGeminiGroup) summaryCoversGemini = true;
      for (const bucket of buckets) {
        if (typeof bucket.remainingFraction !== "number") continue;
        const remainingFraction = clampFraction(bucket.remainingFraction);
        const windowLabel = formatWindowName(bucket.window, bucket.displayName);
        const label = isGeminiGroup
          ? geminiWindowLabel(shortGroup || "Gemini", windowLabel)
          : shortGroup && windowLabel
            ? `${shortGroup} · ${windowLabel}`
            : shortGroup || windowLabel || bucket.displayName || bucket.bucketId || "Quota";
        summaryWindows.push({
          id: bucket.bucketId || label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          label,
          ...(shortGroup ? { group: shortGroup } : {}),
          ...(bucket.window ? { window: bucket.window } : {}),
          usedPercent: usedPercentFromRemaining(remainingFraction),
          remainingFraction,
          ...(bucket.resetTime ? { resetTime: bucket.resetTime } : {}),
        });
      }
    }
  }

  const geminiWindows: GeminiQuotaWindow[] = [];
  if (!summaryCoversGemini && quota.success && quota.data.buckets) {
    const geminiBuckets = quota.data.buckets.filter(
      (b) => typeof b.modelId === "string"
        && b.modelId.toLowerCase().startsWith("gemini-")
        && typeof b.remainingFraction === "number",
    );
    interface GeminiPool {
      remainingFraction: number;
      resetTime?: string;
      modelIds: string[];
    }
    const pools = new Map<string, GeminiPool>();
    for (const bucket of geminiBuckets) {
      const remainingFraction = clampFraction(bucket.remainingFraction ?? 1);
      const resetTime = bucket.resetTime;
      const key = `${resetTime ?? ""}|${remainingFraction.toFixed(4)}`;
      const existing = pools.get(key);
      if (existing) {
        existing.modelIds.push(bucket.modelId || "");
      } else {
        pools.set(key, {
          remainingFraction,
          resetTime,
          modelIds: [bucket.modelId || ""],
        });
      }
    }
    const sortedPools = [...pools.values()].sort((a, b) => a.remainingFraction - b.remainingFraction);
    sortedPools.forEach((pool, index) => {
      const baseLabel = poolLabelForGeminiModels(pool.modelIds, index, sortedPools.length);
      const inferredWindow = inferWindowFromResetTime(pool.resetTime, fetchedAt);
      const label = geminiWindowLabel(baseLabel, inferredWindow);
      geminiWindows.push({
        id: sortedPools.length === 1 ? "gemini-quota" : `gemini-quota-${index + 1}`,
        label,
        group: baseLabel,
        ...(inferredWindow ? { window: inferredWindow.toLowerCase() } : {}),
        usedPercent: usedPercentFromRemaining(pool.remainingFraction),
        remainingFraction: pool.remainingFraction,
        ...(pool.resetTime ? { resetTime: pool.resetTime } : {}),
      });
    });
  }

  const full: GeminiAccountUsage = {
    available: geminiWindows.length > 0 || summaryWindows.length > 0,
    ...(input.email ? { email: input.email } : {}),
    ...(plan ? { plan } : {}),
    ...(tier ? { tier } : {}),
    windows: [...geminiWindows, ...summaryWindows],
    fetchedAt,
  };
  return input.model !== undefined ? selectGeminiUsageForModel(full, input.model) : full;
}

function oauthTokenPath(): string {
  const configDir = process.env.AGY_CONFIG_DIR || path.join(os.homedir(), ".gemini", "antigravity-cli");
  return path.join(configDir, "antigravity-oauth-token");
}

interface AgyOAuthCredentials {
  accessToken: string;
  expiry?: string;
  email?: string;
}

function readAgyOAuthCredentials(): AgyOAuthCredentials | null {
  const tokenPath = oauthTokenPath();
  if (!fs.existsSync(tokenPath)) return null;
  const rawText = fs.readFileSync(tokenPath, "utf8");
  const rawJson: unknown = JSON.parse(rawText);
  const parsed = oauthTokenFileSchema.safeParse(rawJson);
  if (!parsed.success) return null;
  return {
    accessToken: parsed.data.token.access_token,
    expiry: parsed.data.token.expiry,
    email: parsed.data.id_token_email,
  };
}

function isTokenExpiringSoon(expiry?: string): boolean {
  if (!expiry) return false;
  const expiresAtMs = Date.parse(expiry);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= Date.now() + EXPIRY_SKEW_MS;
}

async function refreshAgyOAuthToken(): Promise<boolean> {
  if (tokenRefreshInFlight) return tokenRefreshInFlight;
  const command = resolveAgyCommand();
  if (!command) return false;
  tokenRefreshInFlight = execFileAsync(command, ["models"], {
    timeout: TOKEN_REFRESH_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      tokenRefreshInFlight = null;
    });
  return tokenRefreshInFlight;
}

function antigravityUserAgent(): string {
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/1.5.13 ${process.platform}/${arch}`;
}

async function postCodeAssistJson(
  endpoint: string,
  rpcPath: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${endpoint}${rpcPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new CodeAssistHttpError(response.status, rpcPath);
  }
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

async function fetchFullGeminiAccountUsageWithCreds(
  endpoint: string,
  creds: AgyOAuthCredentials,
): Promise<GeminiAccountUsage | null> {
  const loadCodeAssistRaw = await postCodeAssistJson(endpoint, "/v1internal:loadCodeAssist", creds.accessToken, {
    metadata: { ideType: "ANTIGRAVITY" },
  });
  const codeAssist = loadCodeAssistResponseSchema.safeParse(loadCodeAssistRaw);
  const project = codeAssist.success ? codeAssist.data.cloudaicompanionProject : undefined;
  if (!project) return null;

  const [summaryResult, quotaResult] = await Promise.allSettled([
    postCodeAssistJson(endpoint, "/v1internal:retrieveUserQuotaSummary", creds.accessToken, { project }),
    postCodeAssistJson(endpoint, "/v1internal:retrieveUserQuota", creds.accessToken, { project }),
  ]);

  if (summaryResult.status === "rejected" && quotaResult.status === "rejected") {
    throw summaryResult.reason instanceof Error
      ? summaryResult.reason
      : new Error("Failed to fetch Gemini quota");
  }

  return parseGeminiQuotaUsage({
    loadCodeAssist: loadCodeAssistRaw,
    summary: summaryResult.status === "fulfilled" ? summaryResult.value : undefined,
    quota: quotaResult.status === "fulfilled" ? quotaResult.value : undefined,
    email: creds.email,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Fetches live Gemini / Antigravity account quota windows using the local agy
 * OAuth credentials, refreshing an expired token via `agy models` when needed.
 * Persists the full reading to disk and returns only the active model's pool.
 */
export async function fetchGeminiAccountUsage(options: { model?: string } = {}): Promise<GeminiAccountUsage | null> {
  let creds = readAgyOAuthCredentials();
  if (!creds) return null;

  if (isTokenExpiringSoon(creds.expiry)) {
    const refreshed = await refreshAgyOAuthToken();
    if (refreshed) creds = readAgyOAuthCredentials() ?? creds;
  }

  const endpoint = (process.env.GOOGLE_CLOUD_ASSIST_ENDPOINT || DEFAULT_CLOUD_CODE_ENDPOINT).replace(/\/+$/, "");
  let fullUsage: GeminiAccountUsage | null;
  try {
    fullUsage = await fetchFullGeminiAccountUsageWithCreds(endpoint, creds);
  } catch (error: unknown) {
    if (error instanceof CodeAssistHttpError && error.status === 401) {
      const refreshed = await refreshAgyOAuthToken();
      const updatedCreds = refreshed ? readAgyOAuthCredentials() : null;
      if (updatedCreds && updatedCreds.accessToken !== creds.accessToken) {
        fullUsage = await fetchFullGeminiAccountUsageWithCreds(endpoint, updatedCreds);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (!fullUsage) return null;
  if (fullUsage.available) rememberGeminiUsage(fullUsage);
  return selectGeminiUsageForModel(fullUsage, options.model);
}
