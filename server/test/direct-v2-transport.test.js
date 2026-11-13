const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { WebSocket, WebSocketServer } = require("ws");
const dataDir = require("./test-data-dir");

const { DeviceRegistry } = require("#server/device-registry");
const { DirectV2Sockets, DirectV2Transport } = require("#server/direct-v2-transport");
const { hasOriginHeader, isLoopbackRequest } = require("#server/loopback-request");
const { generateKeyPair } = require("#server/noise-ikpsk1");
const { channelKindForMessage, relayPeerKeyForMessage } = require("#server/relay-client");
const { TransportResponder } = require("#server/transport-responder");
const { parseJsonObject } = require("#server/value-guards");
const { dial } = require("./v2-initiator");

// The direct `?e2e=2` socket of wire spec 5.2, over a real loopback
// WebSocket, and the one loopback check every local-only rule uses.

const ROOM_ID = "ab".repeat(32);
let counter = 0;

/**
 * A listener that hands every socket to a DirectV2Transport, as the index
 * does for an `e2e=2` upgrade.
 * @param {import("node:test").TestContext} t
 */
async function listener(t) {
  const registry = new DeviceRegistry(path.join(dataDir, `direct-v2-${++counter}.json`));
  const serverKeys = generateKeyPair();
  const responder = new TransportResponder({ registry, keyPair: () => serverKeys, roomId: () => ROOM_ID, serverVersion: "1.1.530" });
  const sockets = new DirectV2Sockets();
  /** @type {import("#server/protocol").ClientMessage[]} */
  const delivered = [];
  /** @type {import("#server/transport-responder").PendingNotice[]} */
  const prompts = [];
  /** @type {string[]} */
  const cleared = [];
  let opened = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  server.on("connection", (ws) => {
    sockets.add(new DirectV2Transport(ws, {
      responder,
      fromThisComputer: true,
      serverCapabilities: (_binary, lane) => ({ type: "server_capabilities", lane, transport: { version: 2 } }),
      onOpen: () => { opened++; },
      onMessage: (_transport, message) => delivered.push(message),
      onDevicePending: (notice) => prompts.push(notice),
      onPendingDropped: (publicKey) => cleared.push(publicKey),
      onClose: (transport) => sockets.delete(transport),
    }));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  /** Connects and collects what the computer sends and how the socket closes. */
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/?e2e=2`);
    /** @type {string[]} */
    const received = [];
    /** @type {(() => void)[]} */
    const waiting = [];
    let closeCode = 0;
    const wake = () => { for (const resolve of waiting.splice(0)) resolve(); };
    ws.on("message", (data) => { received.push(String(data)); wake(); });
    ws.on("close", (code) => { closeCode = code; wake(); });
    await once(ws, "open");
    return {
      ws,
      received,
      /** Resolves once `count` frames have arrived or the socket has closed. */
      async frames(/** @type {number} */ count) {
        while (received.length < count && closeCode === 0) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
        return received;
      },
      async closed() {
        while (closeCode === 0) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
        return closeCode;
      },
      /** Resolves once the computer has handled every frame sent so far. */
      async settled() {
        ws.ping();
        await once(ws, "pong");
      },
    };
  };
  /** @param {Partial<Parameters<typeof dial>[0]>} options */
  const device = (options = {}) => dial({ serverKey: serverKeys.publicKey, secret: registry.currentSecret().secret, roomId: ROOM_ID, path: "direct", ...options });
  /** Runs a device's handshake on a new socket up to `hs2`. */
  const handshake = async (/** @type {ReturnType<typeof dial>} */ dialled) => {
    const socket = await connect();
    socket.ws.send(dialled.hs1);
    const channel = dialled.finish((await socket.frames(1))[0]);
    /** Opens the sealed frame at `index`, counting `hs2` as the first. */
    const open = (/** @type {number} */ index) => {
      const parsed = parseJsonObject(socket.received[index]);
      return parseJsonObject(channel.channel.openText({ n: String(parsed.n), c: String(parsed.c) }));
    };
    return { ...socket, channel, open };
  };
  return { registry, sockets, delivered, prompts, cleared, connect, device, handshake, opened: () => opened };
}

test("a direct v2 socket sends hs2 and nothing else until transport_ready, then server_capabilities first", async (t) => {
  const env = await listener(t);
  const device = env.device({ lane: "bulk", keys: generateKeyPair() });
  // Bulk only opens for a recorded device.
  env.registry.enroll({ publicKey: device.publicKey, kind: "device", name: "Pixel", platform: "android", via: "token" });
  const socket = await env.handshake(device);
  assert.equal(socket.channel.answer.status, "open");
  await socket.settled();
  assert.equal(socket.received.length, 1);
  assert.equal(env.opened(), 0);

  socket.ws.send(socket.channel.ready());
  await socket.frames(2);
  assert.deepEqual(socket.open(1), { type: "server_capabilities", lane: "bulk", transport: { version: 2 } });
  assert.equal(env.opened(), 1);
  assert.equal(env.registry.get(device.publicKey)?.transport, 2);
  assert.deepEqual(env.sockets.openKeys(), [device.publicKey]);

  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  // A sealed message this server does not know is answered, not punished.
  socket.ws.send(socket.channel.seal({ type: "no_such_message" }));
  await socket.frames(3);
  assert.deepEqual(socket.open(2), { type: "error", message: "Invalid JSON" });
  assert.deepEqual(env.delivered.map((message) => message.type), ["list_sessions"]);
  assert.equal(channelKindForMessage(env.delivered[0]), "v2");
  assert.equal(relayPeerKeyForMessage(env.delivered[0]), device.publicKey);

  // pairing_update goes to control channels only.
  assert.deepEqual(env.sockets.sendToControl({ type: "pairing_update", secret: "s", roomId: ROOM_ID }), []);
});

test("a direct v2 socket closes on any frame it does not expect", async (t) => {
  const env = await listener(t);

  // Before the handshake: the old openers, the token in the clear, a binary frame.
  for (const first of [
    JSON.stringify({ type: "key_exchange", pubkey: Buffer.alloc(32, 1).toString("base64") }),
    JSON.stringify({ type: "list_sessions", token: "token" }),
    "not json",
    JSON.stringify({ type: "hs1", v: 2, pad: "x".repeat(5000) }),
    Buffer.from("binary"),
  ]) {
    const socket = await env.connect();
    socket.ws.send(first);
    assert.equal(await socket.closed(), 1008);
    assert.deepEqual(socket.received, []);
  }

  // A first record that is not transport_ready.
  const early = await env.handshake(env.device());
  early.ws.send(early.channel.seal({ type: "list_sessions" }));
  assert.equal(await early.closed(), 1008);

  // An unsealed frame after the handshake.
  const unsealed = await env.handshake(env.device());
  unsealed.ws.send(unsealed.channel.ready());
  await unsealed.frames(2);
  unsealed.ws.send(JSON.stringify({ type: "list_sessions" }));
  assert.equal(await unsealed.closed(), 1008);

  // A record whose counter does not increase.
  const replayed = await env.handshake(env.device());
  replayed.ws.send(replayed.channel.ready());
  await replayed.frames(2);
  const record = replayed.channel.seal({ type: "list_sessions" });
  replayed.ws.send(record);
  replayed.ws.send(record);
  assert.equal(await replayed.closed(), 1008);

  assert.deepEqual(env.delivered.map((message) => message.type), ["list_sessions"]);
  // Only the two that sent transport_ready were ever recorded.
  assert.equal(env.registry.list().length, 2);
});

test("a wrong secret or a second hs1 on a direct v2 socket gets no answer", async (t) => {
  const env = await listener(t);
  const wrong = await env.connect();
  wrong.ws.send(env.device({ secret: Buffer.alloc(32, 4).toString("base64") }).hs1);
  // One handshake per socket: a good hs1 after a failed one is ignored too.
  wrong.ws.send(env.device().hs1);
  await wrong.settled();
  assert.deepEqual(wrong.received, []);

  const device = env.device();
  const socket = await env.handshake(device);
  socket.ws.send(device.hs1);
  await socket.settled();
  assert.equal(socket.received.length, 1);
  assert.deepEqual(env.registry.list(), []);
});

test("a locked computer holds a new key on a direct v2 socket until it is allowed or denied", async (t) => {
  const env = await listener(t);
  env.registry.lock();

  const allowed = env.device({ payload: { app: "1.2.0", name: "Laptop", platform: "linux", caps: {} } });
  const socket = await env.handshake(allowed);
  assert.equal(socket.channel.answer.status, "pending");
  socket.ws.send(socket.channel.ready());
  // A held peer's records are ignored.
  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  await socket.settled();
  assert.deepEqual(env.prompts, [{ publicKey: allowed.publicKey, name: "Laptop", platform: "linux", code: socket.channel.code }]);
  assert.equal(env.sockets.isKeyHeld(allowed.publicKey), true);
  assert.equal(socket.received.length, 1);
  assert.equal(env.delivered.length, 0);
  assert.equal(env.registry.get(allowed.publicKey), undefined);

  // device_approve: the index records the key, then opens its sockets.
  env.registry.enroll({ publicKey: allowed.publicKey, kind: "device", name: "Laptop", platform: "linux", via: "approval" });
  env.sockets.approveKey(allowed.publicKey);
  await socket.frames(3);
  assert.deepEqual(socket.open(1), { type: "device_auth_result", ok: true });
  assert.equal(socket.open(2).type, "server_capabilities");
  assert.equal(env.registry.get(allowed.publicKey)?.transport, 2);

  // device_deny: told once, then closed, and the prompt is cleared.
  const denied = env.device();
  const other = await env.handshake(denied);
  other.ws.send(other.channel.ready());
  await other.settled();
  env.sockets.denyKey(denied.publicKey);
  assert.equal(await other.closed(), 1008);
  assert.deepEqual(other.open(1), { type: "device_auth_result", ok: false, reason: "not_approved" });
  // The computer's side of the close lands a moment after the device's.
  while (env.cleared.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(env.cleared, [denied.publicKey]);
  assert.equal(env.registry.get(denied.publicKey), undefined);
});

test("loopback means a loopback address with no proxy in front", () => {
  /** @param {string} address @param {Record<string, string>} headers */
  const request = (address, headers = {}) => {
    const socket = new net.Socket();
    Object.defineProperty(socket, "remoteAddress", { value: address });
    const req = new http.IncomingMessage(socket);
    Object.assign(req.headers, headers);
    return req;
  };
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackRequest(request(address)), true, address);
  for (const address of ["192.168.1.20", "100.64.0.3", "::ffff:192.168.1.20", ""]) assert.equal(isLoopbackRequest(request(address)), false, address);
  // A tunnel or reverse proxy on this computer connects from loopback for someone who is not here.
  for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
    assert.equal(isLoopbackRequest(request("127.0.0.1", { [header]: "203.0.113.9" })), false, header);
  }
  assert.equal(hasOriginHeader(request("127.0.0.1", { origin: "https://example.com" })), true);
  assert.equal(hasOriginHeader(request("127.0.0.1", { origin: "null" })), true);
  assert.equal(hasOriginHeader(request("127.0.0.1")), false);
});
