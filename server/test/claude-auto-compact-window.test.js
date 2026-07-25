const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeClaudeAutoCompactWindow,
} = require("../dist/server-settings");

test("normalizes valid Claude auto-compact server defaults", () => {
  assert.equal(normalizeClaudeAutoCompactWindow(100000), 100000);
  assert.equal(normalizeClaudeAutoCompactWindow(350000), 350000);
  assert.equal(normalizeClaudeAutoCompactWindow(1000000), 1000000);
  assert.equal(normalizeClaudeAutoCompactWindow(null), null);
  assert.equal(normalizeClaudeAutoCompactWindow(undefined), null);
});

test("rejects invalid Claude auto-compact server defaults", () => {
  for (const value of [99999, 1000001, 250000.5, "not-a-number"]) {
    assert.throws(
      () => normalizeClaudeAutoCompactWindow(value),
      /100,000 to 1,000,000/,
    );
  }
});
