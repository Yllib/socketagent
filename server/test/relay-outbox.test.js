const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");

const {
  RelayClient,
  RelayMessageOutbox,
  VirtualRelaySocket,
} = require("../dist/relay-client");

test("relay capability handshake uses the authoritative server payload", () => {
  const expected = {
    type: "server_capabilities",
    sessionTransfer: { version: 1 },
    htmlPlans: { version: 2 },
    backends: ["claude", "codex"],
  };
  const calls = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: "test",
    keyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(64),
    },
    lane: "control",
    serverCapabilities(binaryEnvelope, lane) {
      calls.push({ binaryEnvelope, lane });
      return expected;
    },
    onMessage() {},
    onStatusChange() {},
  });

  let sent;
  client.sendToPeer = (_peerId, message) => {
    sent = message;
  };
  client.dispatchClientMessage({
    type: "client_capabilities",
    binaryEnvelope: true,
  });

  assert.deepEqual(calls, [{ binaryEnvelope: true, lane: "control" }]);
  assert.equal(sent, expected);
  assert.deepEqual(sent.sessionTransfer, { version: 1 });
});

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

test("relay outbox keeps only the latest cumulative stream revision", () => {
  const outbox = new RelayMessageOutbox();
  outbox.enqueue({
    type: "text",
    sessionId: "session-1",
    entryId: "entry-1",
    streamId: "stream-1",
    revision: 1,
    content: "one",
  });
  outbox.enqueue({
    type: "text",
    sessionId: "session-1",
    entryId: "entry-1",
    streamId: "stream-1",
    revision: 9,
    content: "one complete snapshot",
  });
  outbox.enqueue({ type: "tool_call", toolUseId: "tool-1" });

  const drained = outbox.drain();
  assert.equal(drained.messages.length, 2);
  assert.equal(drained.messages[0].revision, 9);
  assert.equal(drained.messages[0].content, "one complete snapshot");
  assert.equal(drained.messages[1].type, "tool_call");
  assert.equal(drained.droppedMessages, 0);
});

test("relay outbox does not retain raw debug traffic while offline", () => {
  const outbox = new RelayMessageOutbox();
  outbox.enqueue({ type: "sdk_event", method: "item/agentMessage/delta" });
  outbox.enqueue({ type: "tool_call", toolUseId: "tool-1" });

  const drained = outbox.drain();
  assert.deepEqual(drained.messages.map((message) => message.type), ["tool_call"]);
  assert.equal(drained.droppedMessages, 0);
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

test('request replies target one peer; live events still broadcast', () => {
  const crypto = require('../dist/relay-crypto');
  const client = new RelayClient({ relayUrl:'wss://relay.invalid', pairingToken:'test',
    keyPair:crypto.generateKeyPair(), serverCapabilities:()=>({}), onMessage(){}, onStatusChange(){} });
  client.ws = {readyState: WebSocket.OPEN};
  for (const id of ['phone','desktop']) client.getPeer(id).publicKey = crypto.generateKeyPair().publicKey;
  const sends = [];
  client.sendToPeer = (id,msg) => sends.push([id,msg.type]);
  const socket = new VirtualRelaySocket(client);
  socket.sendReply('phone', JSON.stringify({type:'session_history'}));
  socket.sendReply('disconnected', JSON.stringify({type:'session_history'}));
  socket.send(JSON.stringify({type:'text'}));
  assert.deepEqual(sends, [['phone','session_history'],['phone','text'],['desktop','text']]);
  assert.deepEqual(client.outbox.drain().messages, []);
});
