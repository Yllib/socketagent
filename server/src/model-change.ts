import type { ModelChangedServerMessage } from "./protocol";
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
