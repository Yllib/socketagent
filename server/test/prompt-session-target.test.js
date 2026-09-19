const assert = require("node:assert/strict");
const test = require("node:test");

const { promptNeedsSessionRebind } = require("../dist/prompt-session-target");

const OPEN = "064cb7b0-0696-43d9-8726-01f4866a8eea";
const OTHER = "756baf17-9f8e-46c5-bedb-bf7282485fe8";

test("a prompt for one session never runs against another", () => {
  assert.equal(promptNeedsSessionRebind(OPEN, OTHER), true);
});

test("the bound session is kept when it is the one the prompt names", () => {
  assert.equal(promptNeedsSessionRebind(OPEN, OPEN), false);
});

test("a prompt with no named session uses whatever the connection has open", () => {
  // New chats send no sessionId; the connection's session is the only target.
  assert.equal(promptNeedsSessionRebind(undefined, OTHER), false);
  assert.equal(promptNeedsSessionRebind("", OTHER), false);
  assert.equal(promptNeedsSessionRebind("   ", OTHER), false);
});

test("an unnamed backend session is left alone for the caller to resolve", () => {
  // A session created for this connection but not yet named by the backend.
  assert.equal(promptNeedsSessionRebind(OPEN, undefined), false);
  assert.equal(promptNeedsSessionRebind(OPEN, ""), false);
});

test("surrounding whitespace is not a mismatch", () => {
  assert.equal(promptNeedsSessionRebind(` ${OPEN} `, OPEN), false);
  assert.equal(promptNeedsSessionRebind(OPEN, ` ${OPEN}`), false);
});
