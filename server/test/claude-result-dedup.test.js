const assert = require("node:assert/strict");
const test = require("node:test");

const {
  shouldEmitClaudeResultFallback,
} = require("../dist/claude-session");
const {
  normalizeClaudeResultFallbackHistoryEntries,
} = require("../dist/session-store");

test("emits a result fallback when a local command produced no assistant text", () => {
  assert.equal(shouldEmitClaudeResultFallback("command output", "", false), true);
});

test("does not duplicate a completed assistant event without streamed deltas", () => {
  assert.equal(shouldEmitClaudeResultFallback("command output", "", true), false);
});

test("does not emit a result fallback after streamed text", () => {
  assert.equal(shouldEmitClaudeResultFallback("answer", "answer", false), false);
});

test("collapses the UUID-less Claude result copy in stored history", () => {
  const normalized = normalizeClaudeResultFallbackHistoryEntries([
    {
      role: "assistant",
      content: "Current week (Fable): 0% used",
      uuid: "assistant-event-uuid",
      timestamp: "2026-07-15T00:09:43.396Z",
    },
    {
      role: "assistant",
      content: "Current week (Fable): 0% used",
      timestamp: "2026-07-15T00:09:43.398Z",
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].uuid, "assistant-event-uuid");
});

test("preserves intentional repeated assistant messages", () => {
  const normalized = normalizeClaudeResultFallbackHistoryEntries([
    {
      role: "assistant",
      content: "Same answer",
      uuid: "first",
      timestamp: "2026-07-15T00:00:00.000Z",
    },
    {
      role: "assistant",
      content: "Same answer",
      uuid: "second",
      timestamp: "2026-07-15T00:00:00.010Z",
    },
  ]);

  assert.equal(normalized.length, 2);
});
