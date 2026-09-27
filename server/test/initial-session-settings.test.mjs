import assert from "node:assert/strict";
import test from "node:test";

import { applyInitialSessionSettings, isClaudeEffort } from "#server/initial-session-settings";

function fakeSession() {
  /** @type {[string, unknown][]} */
  const calls = [];
  return {
    calls,
    /** @param {string | undefined} value */
    async setModel(value) { calls.push(["model", value]); },
    /** @param {string} value */
    setEffort(value) { calls.push(["effort", value]); },
    /** @param {import('#server/protocol').AgentThinkingSetting} value */
    setThinking(value) { calls.push(["thinking", value]); },
    /** @param {boolean} value */
    setClaudeAutoCompact(value) { calls.push(["autoCompact", value]); },
    /** @param {number | null} value */
    setClaudeAutoCompactWindow(value) { calls.push(["autoCompactWindow", value]); },
    /** @param {boolean} value */
    setCodexFastMode(value) { calls.push(["fastMode", value]); },
    /** @param {string} value */
    setCodexCollaborationMode(value) { calls.push(["collaborationMode", value]); },
    /** @param {string} value */
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
    claudeAutoCompactWindow: 350000,
    permissionMode: "default",
    codexFastMode: true,
  });

  assert.deepEqual(applied, {
    model: "opus",
    effort: "xhigh",
    thinking: { type: "adaptive" },
    claudeAutoCompact: false,
    claudeAutoCompactWindow: 350000,
    permissionMode: "default",
  });
  assert.deepEqual(session.calls, [
    ["model", "opus"],
    ["effort", "xhigh"],
    ["thinking", { type: "adaptive" }],
    ["autoCompact", false],
    ["autoCompactWindow", 350000],
    ["permissionMode", "default"],
  ]);
});

test("rejects Claude auto-compact windows outside the SDK range", async () => {
  for (const claudeAutoCompactWindow of [99999, 1000001, 250000.5, "nope"]) {
    const session = fakeSession();
    const applied = await applyInitialSessionSettings(session, "claude", {
      claudeAutoCompactWindow,
    });
    assert.equal(applied.claudeAutoCompactWindow, undefined);
    assert.equal(
      session.calls.some(([name]) => name === "autoCompactWindow"),
      false,
    );
  }
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


test("normalizes legacy Claude permission mode and rejects unsupported effort", async () => {
  const session = fakeSession();
  const applied = await applyInitialSessionSettings(session, "claude", {
    permissionMode: "superYolo", effort: "ultra",
  });
  assert.deepEqual(applied, { permissionMode: "bypassPermissions" });
  assert.deepEqual(session.calls, [["permissionMode", "bypassPermissions"]]);
  assert.equal(isClaudeEffort("xhigh"), true);
  assert.equal(isClaudeEffort("ultra"), false);
  assert.equal(isClaudeEffort({ effort: "high" }), false);
});
