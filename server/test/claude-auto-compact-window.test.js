const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
  normalizeClaudeAutoCompactWindow,
  resolvePersistedClaudeAutoCompactWindow,
} = require("../dist/server-settings");

test("normalizes valid Claude auto-compact server defaults", () => {
  assert.equal(normalizeClaudeAutoCompactWindow(100000), 100000);
  assert.equal(normalizeClaudeAutoCompactWindow(350000), 350000);
  assert.equal(normalizeClaudeAutoCompactWindow(1000000), 1000000);
  assert.equal(normalizeClaudeAutoCompactWindow(null), null);
  assert.equal(normalizeClaudeAutoCompactWindow(""), null);
});

test("defaults an absent Claude auto-compact window to 250,000 tokens", () => {
  assert.equal(DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW, 250000);
  assert.equal(
    normalizeClaudeAutoCompactWindow(undefined),
    DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW,
  );
});

test("migrates legacy implicit null while preserving explicit SDK opt-out", () => {
  assert.equal(
    resolvePersistedClaudeAutoCompactWindow(undefined, false),
    250000,
  );
  assert.equal(resolvePersistedClaudeAutoCompactWindow(null, false), 250000);
  assert.equal(resolvePersistedClaudeAutoCompactWindow(null, true), null);
  assert.equal(resolvePersistedClaudeAutoCompactWindow(225000, false), 225000);
  assert.equal(resolvePersistedClaudeAutoCompactWindow(350000, true), 350000);
});

test("rejects invalid Claude auto-compact server defaults", () => {
  for (const value of [99999, 1000001, 250000.5, "not-a-number"]) {
    assert.throws(
      () => normalizeClaudeAutoCompactWindow(value),
      /100,000 to 1,000,000/,
    );
  }
});
