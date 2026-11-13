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
const { hasOriginHeader, hasReadableTarget, isLoopbackRequest } = require("#server/loopback-request");
const { generateKeyPair } = require("#server/noise-ikpsk1");
const { channelKindForMessage, relayPeerKeyForMessage } = require("#server/relay-client");
const { MAX_FAILED_HS1_PER_ADDRESS, TransportResponder } = require("#server/transport-responder");
const { encodeHs1Frame, parseHs1Frame, secretTag } = require("#server/transport-v2");
const { parseJsonObject } = require("#server/value-guards");
const { dial } = require("./v2-initiator");

// The direct `?e2e=2` socket of wire spec 5.2 and the `local-request` path
// of 5.3, over a real loopback WebSocket, and the one loopback check every
// local-only rule uses.

const ROOM_ID = "ab".repeat(32);
let counter = 0;

/**
 * A listener that hands every socket to a DirectV2Transport, as the index
 * does for an `e2e=2` upgrade.
 * @param {import("node:test").TestContext} t
 * @param {string} [remoteAddress] The address the sockets are taken to come from. Loopback when left out.
 */
async function listener(t, remoteAddress) {
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
  server.on("connection", (ws, req) => {
    sockets.add(new DirectV2Transport(ws, {
      responder,
      fromThisComputer: isLoopbackRequest(req),
      remoteAddress: remoteAddress ?? req.socket.remoteAddress,
      serverCapabilities: (_binary, lane) => ({ type: "server_capabilities", lane, transport: { version: 2 } }),
      pairingGrant: () => ({ type: "pairing_grant", secret: registry.currentSecret().secret, roomId: ROOM_ID, port: 8085, hosts: ["192.168.1.20"] }),
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

  /**
   * Connects and collects what the computer sends and how the socket closes.
   * @param {Record<string, string>} headers
   */
  const connect = async (headers = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/?e2e=2`, { headers });
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
  /**
   * Runs a device's handshake on a new socket up to `hs2`.
   * @param {ReturnType<typeof dial>} dialled
   * @param {Record<string, string>} headers
   */
  const handshake = async (dialled, headers = {}) => {
    const socket = await connect(headers);
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

  // Nothing over 4,096 bytes is read before transport_ready, text or binary.
  for (const large of ["x".repeat(4097), Buffer.alloc(4097)]) {
    const waiting = await env.handshake(env.device());
    waiting.ws.send(large);
    assert.equal(await waiting.closed(), 1008);
    assert.equal(waiting.received.length, 1, "only hs2 was ever sent");
  }

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

test("a dropped direct v2 socket delivers nothing more, before the peer has answered the close", async (t) => {
  const env = await listener(t);
  const device = env.device();
  env.registry.enroll({ publicKey: device.publicKey, kind: "device", name: "Pixel", platform: "android", via: "token" });
  const socket = await env.handshake(device);
  socket.ws.send(socket.channel.ready());
  await socket.frames(2);
  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  await socket.settled();
  assert.deepEqual(env.delivered.map((message) => message.type), ["list_sessions"]);

  // The computer removes the device, in the order device-removal.ts uses.
  env.sockets.dropKey(device.publicKey, "Removed");
  env.registry.revoke(device.publicKey);
  // The channel is gone in the same tick, while the socket is still closing.
  assert.deepEqual(env.sockets.openKeys(), []);

  // The device has not read the close frame yet and sends one more message.
  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  assert.equal(await socket.closed(), 1008);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.delivered.map((message) => message.type), ["list_sessions"], "nothing sent after the drop was delivered");
});

test("a denied held peer on a direct v2 socket is not read again", async (t) => {
  const env = await listener(t);
  env.registry.lock();
  const socket = await env.handshake(env.device());
  socket.ws.send(socket.channel.ready());
  await socket.settled();
  assert.equal(env.prompts.length, 1);

  env.sockets.denyKey(env.prompts[0].publicKey);
  assert.equal(env.sockets.isKeyHeld(env.prompts[0].publicKey), false);
  assert.deepEqual(env.cleared, [env.prompts[0].publicKey]);
  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  assert.equal(await socket.closed(), 1008);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.delivered, []);
  assert.deepEqual(env.cleared, [env.prompts[0].publicKey], "the prompt is cleared once");
});

test("failed handshakes are counted against the direct socket's address", async (t) => {
  const env = await listener(t, "192.168.1.66");
  // The public tag of the current secret over a handshake made under another secret.
  const tag = secretTag(Buffer.from(env.registry.currentSecret().secret, "base64"));
  for (let attempt = 0; attempt < MAX_FAILED_HS1_PER_ADDRESS; attempt++) {
    const frame = parseHs1Frame(env.device({ secret: Buffer.alloc(32, 4).toString("base64") }).hs1);
    assert.ok(frame);
    const socket = await env.connect();
    socket.ws.send(encodeHs1Frame({ ...frame, tag }));
    await socket.settled();
    socket.ws.close();
  }
  // The right secret from that address is now ignored for the rest of the minute.
  const socket = await env.connect();
  socket.ws.send(env.device().hs1);
  await socket.settled();
  assert.deepEqual(socket.received, []);
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

test("local-request sends a recorded device pairing_grant and closes, and reads nothing else", async (t) => {
  const env = await listener(t);
  const device = env.device({ path: "local-request", keys: generateKeyPair() });
  env.registry.enroll({ publicKey: device.publicKey, kind: "device", name: "Desktop app", platform: "windows", via: "approval" });
  const socket = await env.handshake(device);
  assert.equal(socket.channel.answer.status, "open");
  await socket.settled();
  assert.equal(socket.received.length, 1, "nothing follows hs2 before transport_ready");

  socket.ws.send(socket.channel.ready());
  // A message an open channel would act on. This path never opens one.
  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  assert.equal(await socket.closed(), 1000);
  assert.equal(socket.received.length, 2);
  assert.deepEqual(socket.open(1), {
    type: "pairing_grant", secret: env.registry.currentSecret().secret, roomId: ROOM_ID, port: 8085, hosts: ["192.168.1.20"],
  });
  assert.equal(env.opened(), 0);
  assert.deepEqual(env.delivered, []);
  assert.deepEqual(env.sockets.openKeys(), []);
});

test("local-request holds an unknown key and grants only after Allow", async (t) => {
  const env = await listener(t);
  // Not locked. This path asks all the same.
  const allowed = env.device({ path: "local-request", payload: { app: "1.2.0", name: "Second account", platform: "windows", caps: {} } });
  const socket = await env.handshake(allowed);
  assert.equal(socket.channel.answer.status, "pending");
  await socket.settled();
  assert.deepEqual(env.prompts, [], "no prompt before transport_ready");

  socket.ws.send(socket.channel.ready());
  socket.ws.send(socket.channel.seal({ type: "pairing_upgrade", requestId: "r1" }));
  socket.ws.send(socket.channel.seal({ type: "list_sessions" }));
  await socket.settled();
  assert.deepEqual(env.prompts, [{ publicKey: allowed.publicKey, name: "Second account", platform: "windows", code: socket.channel.code }]);
  assert.equal(socket.received.length, 1, "no grant and no answer while it waits");
  assert.deepEqual(env.delivered, []);
  assert.equal(env.registry.get(allowed.publicKey), undefined);

  // device_approve: the index records the key, then tells the socket.
  env.registry.enroll({ publicKey: allowed.publicKey, kind: "device", name: "Second account", platform: "windows", via: "approval" });
  env.sockets.approveKey(allowed.publicKey);
  assert.equal(await socket.closed(), 1000);
  assert.equal(socket.received.length, 2);
  const grant = socket.open(1);
  assert.equal(grant.type, "pairing_grant");
  assert.equal(grant.secret, env.registry.currentSecret().secret);
  assert.equal(env.opened(), 0);

  // device_deny: the verdict, then the close. No grant.
  const denied = env.device({ path: "local-request" });
  const other = await env.handshake(denied);
  other.ws.send(other.channel.ready());
  await other.settled();
  env.sockets.denyKey(denied.publicKey);
  assert.equal(await other.closed(), 1008);
  assert.equal(other.received.length, 2);
  assert.deepEqual(other.open(1), { type: "device_auth_result", ok: false, reason: "not_approved" });
  assert.equal(env.registry.get(denied.publicKey), undefined);
});

test("local-request gets no answer from a socket with a proxy header, or one that is not this computer", async (t) => {
  const env = await listener(t);
  const device = env.device({ path: "local-request", keys: generateKeyPair() });
  env.registry.enroll({ publicKey: device.publicKey, kind: "device", name: "Desktop app", platform: "windows", via: "approval" });

  // A tunnel on this computer connects from loopback for someone who is not here.
  for (const header of ["X-Forwarded-For", "Forwarded", "X-Real-IP"]) {
    const proxied = await env.connect({ [header]: "203.0.113.9" });
    proxied.ws.send(env.device({ path: "local-request", keys: device.keys }).hs1);
    await proxied.settled();
    assert.deepEqual(proxied.received, [], header);
  }

  // The same transport on a socket the index did not mark as from this computer.
  const outside = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => { for (const socket of outside.clients) socket.terminate(); outside.close(); });
  const responder = new TransportResponder({ registry: env.registry, keyPair: generateKeyPair, roomId: () => ROOM_ID, serverVersion: "1.1.530" });
  let granted = 0;
  outside.on("connection", (ws) => {
    new DirectV2Transport(ws, {
      responder, fromThisComputer: false,
      serverCapabilities: () => ({}), pairingGrant: () => { granted++; return {}; },
      onOpen: () => {}, onMessage: () => {}, onDevicePending: () => {}, onPendingDropped: () => {}, onClose: () => {},
    });
  });
  await once(outside, "listening");
  const address = outside.address();
  assert.ok(address && typeof address !== "string");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/?e2e=2`);
  /** @type {string[]} */
  const received = [];
  ws.on("message", (data) => received.push(String(data)));
  await once(ws, "open");
  ws.send(device.hs1);
  ws.ping();
  await once(ws, "pong");
  assert.deepEqual(received, []);
  assert.equal(granted, 0);
  ws.terminate();

  // From this computer with no proxy header the same key is answered.
  assert.equal((await env.handshake(env.device({ path: "local-request", keys: device.keys }))).channel.answer.status, "open");
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

  // `new URL` throws on a target of `//`, so the listeners ask this before they parse.
  const target = (/** @type {string} */ url) => Object.assign(request("127.0.0.1"), { url });
  for (const url of ["/", "/?e2e=2", "/download-file?path=%2Ftmp"]) assert.equal(hasReadableTarget(target(url)), true, url);
  assert.equal(hasReadableTarget(target("//")), false);
});
