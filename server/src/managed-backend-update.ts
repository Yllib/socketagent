import { unknownArray } from "./value-guards";
import type { Backend } from "./protocol";

export const MANAGED_BACKEND_PACKAGES = [
  { name: "@openai/codex", spec: "@openai/codex@latest", backend: "codex" },
  { name: "@anthropic-ai/claude-code", spec: "@anthropic-ai/claude-code@latest", backend: "claude" },
] as const;

export function parseNpmVersionOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("npm returned an empty version");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (Array.isArray(parsed)) {
      const latest = unknownArray(parsed).filter((value): value is string => typeof value === "string").reverse().find(value => value.trim());
      if (latest) return latest.trim();
    }
  } catch {
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return trimmed;
  }
  throw new Error(`npm returned an invalid version: ${trimmed.slice(0, 120)}`);
}

export function managedBackendSpecsNeedingUpdate(
  installed: Record<string, string | undefined>,
  latest: Record<string, string>,
): string[] {
  return MANAGED_BACKEND_PACKAGES
    .filter(({ name }) => !installed[name] || installed[name] !== latest[name])
    .map(({ spec }) => spec);
}

export function backendsForManagedBackendSpecs(specs: readonly string[]): Backend[] {
  const requested = new Set(specs);
  return MANAGED_BACKEND_PACKAGES
    .filter(({ spec }) => requested.has(spec))
    .map(({ backend }) => backend);
}

export function managedBackendCheckIsDue(
  lastCheckedAtMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (!Number.isFinite(lastCheckedAtMs) || lastCheckedAtMs <= 0) return true;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return true;
  return nowMs - lastCheckedAtMs >= intervalMs;
}

const FIRST_FAILURE_RETRY_MS = 5 * 60 * 1000;

/** One retry deadline shared by startup, periodic checks, and deferred work. */
export class ManagedBackendRetry {
  private timer?: NodeJS.Timeout;
  private retryAfter = 0;
  private failures = 0;

  get isWaiting(): boolean { return Date.now() < this.retryAfter; }

  schedule(delayMs: number, retry: () => void): void {
    this.cancel();
    this.retryAfter = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      retry();
    }, delayMs);
    this.timer.unref();
  }

  /**
   * Retries a failed check after 5 minutes, doubling the wait with each
   * failure in a row up to `maxDelayMs`. Returns the wait.
   */
  scheduleAfterFailure(maxDelayMs: number, retry: () => void): number {
    const delayMs = Math.min(FIRST_FAILURE_RETRY_MS * 2 ** this.failures, maxDelayMs);
    this.failures++;
    this.schedule(delayMs, retry);
    return delayMs;
  }

  /** Drops any pending retry and the failure count, after a check that finished. */
  clear(): void {
    this.cancel();
    this.failures = 0;
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.retryAfter = 0;
  }
}
