import type { ModelChangedServerMessage, ModelNotice } from "./protocol";
import { appendHistory } from "./session-store";

/** A model's display name from `models` (catalog entries), else its id. */
function modelLabel(model: string | undefined, models: ReadonlyArray<Record<string, unknown>>): string {
  if (!model) return "the default model";
  const entry = models.find((candidate) => String(candidate.value || candidate.id || "") === model);
  return String(entry?.displayName || model);
}

/**
 * Saves a model-change card to the session's history and returns the live
 * message for it, or null when the model did not change. Sessions call this
 * from setModel. The first model a session gets is not a change, so a missing
 * `previous` records nothing. `reason` explains a change the server made on
 * its own and replaces the "from" wording.
 */
export function recordModelChange(
  sessionId: string | null | undefined,
  previous: string | null | undefined,
  next: string | undefined,
  models: ReadonlyArray<Record<string, unknown>>,
  reason?: string,
): ModelChangedServerMessage | null {
  if (!sessionId || !previous || previous === next) return null;
  const content = reason
    ? `${reason} Model changed to ${modelLabel(next, models)}.`
    : `Model changed from ${modelLabel(previous, models)} to ${modelLabel(next, models)}`;
  appendHistory(sessionId, { role: "model_change", content, timestamp: new Date().toISOString() });
  return { type: "model_changed", sessionId, content, ...(next ? { model: next } : {}) };
}

/** Saves a server-made model notice card to history and returns its live message. */
export function recordModelNotice(sessionId: string, notice: ModelNotice, content: string): ModelChangedServerMessage {
  appendHistory(sessionId, { role: "model_change", content, modelNotice: notice, timestamp: new Date().toISOString() });
  return { type: "model_changed", sessionId, content, notice };
}

interface ClaudeModelVersion {
  family: string;
  major: number;
  minor: number;
}

/**
 * Family and version of a Claude model id or display name. "claude-opus-4-8",
 * "claude-haiku-4-5-20251001" and "Opus 4.8" all parse. Aliases such as
 * "opus" return null.
 */
export function claudeModelVersion(text: string): ClaudeModelVersion | null {
  const trimmed = text.trim();
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(trimmed)
    || /^([a-z]+) (\d+)(?:\.(\d+))?$/i.exec(trimmed);
  if (!match) return null;
  return { family: match[1].toLowerCase(), major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

/** "Opus 4.8" for a parsed version. */
export function claudeVersionLabel(version: ClaudeModelVersion): string {
  return `${version.family.charAt(0).toUpperCase()}${version.family.slice(1)} ${version.major}.${version.minor}`;
}

function isOlder(left: ClaudeModelVersion, right: ClaudeModelVersion): boolean {
  return left.major < right.major || (left.major === right.major && left.minor < right.minor);
}

/**
 * Warning text for the models in `used` that are older than the newest model
 * of their family in the catalog, or null when every one is current. Alias
 * entries ("opus" shown as "Opus 5.5") carry the newest version.
 */
export function outdatedModelWarning(
  used: readonly string[],
  models: ReadonlyArray<Record<string, unknown>>,
): string | null {
  const newest = new Map<string, ClaudeModelVersion>();
  for (const entry of models) {
    for (const field of [entry.value, entry.id, entry.displayName]) {
      const version = typeof field === "string" ? claudeModelVersion(field) : null;
      const known = version ? newest.get(version.family) : undefined;
      if (version && (!known || isOlder(known, version))) newest.set(version.family, version);
    }
  }
  const lines: string[] = [];
  for (const model of new Set(used)) {
    const version = claudeModelVersion(model);
    const latest = version ? newest.get(version.family) : undefined;
    if (!version || !latest || !isOlder(version, latest)) continue;
    lines.push(`${claudeVersionLabel(version)} answered this turn, not ${claudeVersionLabel(latest)}.`);
  }
  return lines.length > 0 ? `Old model. ${lines.join(" ")}` : null;
}
