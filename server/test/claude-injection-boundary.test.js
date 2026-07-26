const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createClaudeContinuationMessages,
  formatClaudeBoundaryContext,
} = require("../dist/claude-session");

test("formats injected messages as context rather than a cancellation", () => {
  const context = formatClaudeBoundaryContext([
    { text: "Use the public API instead.", uuid: "one" },
    { text: "The fixture is already in /tmp.", uuid: "two" },
  ]);

  assert.match(context, /additional context/i);
  assert.match(context, /not itself a refusal, denial, interruption, or cancellation/i);
  assert.match(context, /Use the public API instead\./);
  assert.match(context, /The fixture is already in \/tmp\./);
});

test("a terminal continuation queries only after all queued context is appended", () => {
  const messages = createClaudeContinuationMessages([
    { text: "first", uuid: "one" },
    { text: "second", uuid: "two" },
    { text: "third", uuid: "three" },
  ], "session-id");

  assert.equal(messages.length, 3);
  assert.equal(messages[0].shouldQuery, false);
  assert.equal(messages[1].shouldQuery, false);
  assert.equal(messages[2].shouldQuery, undefined);
  assert.deepEqual(messages.map((message) => message.uuid), ["one", "two", "three"]);
  assert.ok(messages.every((message) => message.session_id === "session-id"));
});

test("empty boundary context produces no SDK content", () => {
  assert.equal(formatClaudeBoundaryContext([]), "");
  assert.deepEqual(createClaudeContinuationMessages([], "session-id"), []);
});
