const assert = require("node:assert/strict");
const test = require("node:test");

const {
  claudeDisallowedTools,
} = require("../dist/claude-session");

test("always disables Claude's session-scoped native Monitor", () => {
  assert.deepEqual(claudeDisallowedTools([]), ["Monitor"]);
  assert.deepEqual(
    claudeDisallowedTools(["WebSearch", "Monitor"]),
    ["WebSearch", "Monitor"],
  );
});
