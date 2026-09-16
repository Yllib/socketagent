const assert = require("node:assert/strict");
const test = require("node:test");

const { claudeHarnessRunTransition } = require("../dist/claude-session");

test("a harness that wakes itself up starts a tracked run", () => {
  // Background task or subagent finished: no prompt, but Claude is working.
  assert.equal(claudeHarnessRunTransition("running", false, false), "start");
});

test("a prompt's own run is not restarted by its running event", () => {
  assert.equal(claudeHarnessRunTransition("running", true, false), null);
});

test("only self-started runs settle on the idle event", () => {
  assert.equal(claudeHarnessRunTransition("idle", true, true), "end");
  // A prompt's run settles through the result event instead.
  assert.equal(claudeHarnessRunTransition("idle", true, false), null);
});

test("a self-started run settles even though its result already cleared running", () => {
  assert.equal(claudeHarnessRunTransition("idle", false, true), "end");
});

test("other harness states leave run tracking alone", () => {
  assert.equal(claudeHarnessRunTransition("requires_action", true, true), null);
  assert.equal(claudeHarnessRunTransition("idle", false, false), null);
});
