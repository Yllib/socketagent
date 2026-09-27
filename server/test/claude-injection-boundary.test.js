const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createClaudeContinuationMessages,
  formatClaudeBoundaryContext,
} = require("../dist/claude-session");

test("formats injected messages as context rather than a cancellation", () => {
  const context = formatClaudeBoundaryContext([
    { text: "Use the public API instead.", uuid: "00000000-0000-4000-8000-000000000001" },
    { text: "The fixture is already in /tmp.", uuid: "00000000-0000-4000-8000-000000000002" },
  ]);

  assert.match(context, /additional context/i);
  assert.match(context, /not itself a refusal, denial, interruption, or cancellation/i);
  assert.match(context, /Use the public API instead\./);
  assert.match(context, /The fixture is already in \/tmp\./);
});

test("a terminal continuation queries only after all queued context is appended", () => {
  const messages = createClaudeContinuationMessages([
    { text: "first", uuid: "00000000-0000-4000-8000-000000000001" },
    { text: "second", uuid: "00000000-0000-4000-8000-000000000002" },
    { text: "third", uuid: "00000000-0000-4000-8000-000000000003" },
  ], "session-id");

  assert.equal(messages.length, 3);
  assert.equal(messages[0].shouldQuery, false);
  assert.equal(messages[1].shouldQuery, false);
  assert.equal(messages[2].shouldQuery, undefined);
  assert.deepEqual(messages.map((message) => message.uuid), ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]);
  assert.ok(messages.every((message) => message.session_id === "session-id"));
  assert.ok(messages.every((message) => message.origin?.kind === "human"));
});

test("empty boundary context produces no SDK content", () => {
  assert.equal(formatClaudeBoundaryContext([]), "");
  assert.deepEqual(createClaudeContinuationMessages([], "session-id"), []);
});

test("descriptive delivery IDs map to stable native UUIDs", () => {
  const pending = [{ text: "context", uuid: "delegated-report:agent:run" }];
  const [first] = createClaudeContinuationMessages(pending, "session-id");
  const [replay] = createClaudeContinuationMessages(pending, "session-id");
  const [different] = createClaudeContinuationMessages([{ text: "context", uuid: "delegated-report:agent:next-run" }], "session-id");
  assert.match(first.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.uuid, replay.uuid);
  assert.notEqual(first.uuid, different.uuid);
});
