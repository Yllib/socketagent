const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyInitialSessionSettings,
} = require("../dist/initial-session-settings");

function fakeSession() {
  const calls = [];
  return {
    calls,
    async setModel(value) { calls.push(["model", value]); },
    setEffort(value) { calls.push(["effort", value]); },
    setThinking(value) { calls.push(["thinking", value]); },
    setClaudeAutoCompact(value) { calls.push(["autoCompact", value]); },
    setCodexFastMode(value) { calls.push(["fastMode", value]); },
    setCodexCollaborationMode(value) { calls.push(["collaborationMode", value]); },
    async setPermissionMode(value) { calls.push(["permissionMode", value]); },
  };
}

test("applies complete Claude preflight settings before the first turn", async () => {
  const session = fakeSession();
  const applied = await applyInitialSessionSettings(session, "claude", {
    model: "opus",
    effort: "xhigh",
    thinking: { type: "adaptive" },
    claudeAutoCompact: false,
    permissionMode: "default",
    codexFastMode: true,
  });

  assert.deepEqual(applied, {
    model: "opus",
    effort: "xhigh",
    thinking: { type: "adaptive" },
    claudeAutoCompact: false,
    permissionMode: "default",
  });
  assert.deepEqual(session.calls, [
    ["model", "opus"],
    ["effort", "xhigh"],
    ["thinking", { type: "adaptive" }],
    ["autoCompact", false],
    ["permissionMode", "default"],
  ]);
});

test("applies Codex-only settings and rejects invalid client values", async () => {
  const session = fakeSession();
  const applied = await applyInitialSessionSettings(session, "codex", {
    model: "gpt-test",
    effort: "ultra",
    codexFastMode: true,
    codexCollaborationMode: "pair_programming",
    permissionMode: "superYolo",
    thinking: { type: "enabled", budgetTokens: -1 },
    claudeAutoCompact: false,
  });

  assert.deepEqual(applied, {
    model: "gpt-test",
    effort: "ultra",
    codexFastMode: true,
    codexCollaborationMode: "pair_programming",
    permissionMode: "superYolo",
  });
});
