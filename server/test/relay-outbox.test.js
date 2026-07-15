const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");

const {
  RelayMessageOutbox,
  VirtualRelaySocket,
} = require("../dist/relay-client");

test("relay outbox preserves transient tool events in order", () => {
  const outbox = new RelayMessageOutbox();
  outbox.enqueue({ type: "tool_call", toolUseId: "tool-1" });
  outbox.enqueue({ type: "tool_result", toolUseId: "tool-1" });
  outbox.enqueue({ type: "text", content: "continued" });

  const drained = outbox.drain();
  assert.deepEqual(
    drained.messages.map((message) => message.type),
    ["tool_call", "tool_result", "text"],
  );
  assert.equal(drained.droppedMessages, 0);
  assert.equal(outbox.length, 0);
});

test("relay outbox reports bounded overflow for history recovery", () => {
  const outbox = new RelayMessageOutbox(2, 1024);
  outbox.enqueue({ type: "tool_call", toolUseId: "old" });
  outbox.enqueue({ type: "tool_result", toolUseId: "old" });
  outbox.enqueue({ type: "text", content: "new" });

  const drained = outbox.drain();
  assert.equal(drained.droppedMessages, 1);
  assert.deepEqual(
    drained.messages.map((message) => message.type),
    ["tool_result", "text"],
  );
});

test("virtual relay socket remains writable across a peer handoff", () => {
  const relay = { bufferedAmount: 0, send() {} };
  const socket = new VirtualRelaySocket(relay);
  const generation = socket.connectionGeneration;

  assert.equal(socket.readyState, WebSocket.OPEN);
  socket._noteTransportReset();
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(socket.connectionGeneration, generation + 1);
});
