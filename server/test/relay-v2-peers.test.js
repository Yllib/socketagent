const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const nacl = require("tweetnacl");
const { WebSocketServer } = require("ws");
const dataDir = require("./test-data-dir");

const { DeviceAuthGate } = require("#server/device-auth");
const { DeviceRegistry } = require("#server/device-registry");
const { generateKeyPair } = require("#server/noise-ikpsk1");
const { channelKindForMessage, relayAuthMessage, RelayClient } = require("#server/relay-client");
const { TransportResponder } = require("#server/transport-responder");
const { encodeHs1Frame, parseHs1Frame } = require("#server/transport-v2");
const { parseJsonObject } = require("#server/value-guards");
const { dial } = require("./v2-initiator");

// Transport v2 devices in the relay's control and bulk rooms (wire spec 5.1),
// and the new-style relay join (12.1, 12.2).

const ROOM_ID = "ab".repeat(32);
let counter = 0;

/**
 * A relay client with a fake open socket and a real responder. Frames meant
 * for peers are captured instead of sent.
 * @param {"control" | "bulk"} lane
 */
function harness(lane = "control") {
  const registry = new DeviceRegistry(path.join(dataDir, `relay-v2-${++counter}.json`));
  const serverKeys = generateKeyPair();
  /** @type {{peerId: string, data: string}[]} */
  const frames = [];
  /** @type {import("#server/protocol").ClientMessage[]} */
  const delivered = [];
  /** @type {import("#server/transport-responder").PendingNotice[]} */
  const prompts = [];
  /** @type {string[]} */
  const cleared = [];
  const responder = new TransportResponder({ registry, keyPair: () => serverKeys, roomId: () => ROOM_ID, serverVersion: "1.1.530" });
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: ROOM_ID,
    keyPair: serverKeys,
    lane,
    responder,
    peerAuth: new DeviceAuthGate(registry, () => "token"),
    serverCapabilities: (_binary, _lane, _key, transport) => ({ type: "server_capabilities", transport: { version: 2 }, seenAs: transport }),
    onMessage: (msg) => delivered.push(msg),
    onDevicePending: (notice) => prompts.push(notice),
    onPendingDropped: (publicKey) => cleared.push(publicKey),
    onStatusChange: () => {},
  });
  client.sendRawFrameToPeer = (peerId, data, _binary) => {
    frames.push({ peerId, data: String(data) });
  };
  client.ws = { readyState: 1 };
  /** @param {string} data */
  const fromPeer = (data, peerId = "phone-1") => client.handleRelayMessage({ type: "relay_peer_message", peerId, binary: false, data });
  /** @param {Partial<Parameters<typeof dial>[0]>} options */
  const device = (options = {}) => dial({ serverKey: serverKeys.publicKey, secret: registry.currentSecret().secret, roomId: ROOM_ID, lane, ...options });
  /** Sends `hs1` and reads the `hs2` that comes back. */
  const handshake = (/** @type {ReturnType<typeof dial>} */ dialled, peerId = "phone-1") => {
    const before = frames.length;
    fromPeer(dialled.hs1, peerId);
    assert.equal(frames.length, before + 1, "hs1 is answered with hs2 and nothing else");
    return dialled.finish(frames[before].data);
  };
  /** Opens the sealed frames a peer received after its `hs2`. */
  const received = (/** @type {ReturnType<ReturnType<typeof dial>["finish"]>} */ channel, peerId = "phone-1") =>
    frames.filter((frame) => frame.peerId === peerId).slice(1).map((frame) => {
      const parsed = parseJsonObject(frame.data);
      return parseJsonObject(channel.channel.openText({ n: String(parsed.n), c: String(parsed.c) }));
    });
  return { registry, client, frames, delivered, prompts, cleared, fromPeer, device, handshake, received };
}

test("a v2 device gets hs2 and nothing else until transport_ready, then server_capabilities first", () => {
  const h = harness();
  const device = h.device();
  h.client.send({ type: "session_list", sessions: [] });
  const channel = h.handshake(device);
  assert.equal(channel.answer.status, "open");
  assert.equal(channel.answer.server, "1.1.530");
  assert.equal(h.client.isPaired, false, "the handshake alone opens nothing");
  assert.equal(h.registry.get(device.publicKey), undefined);

  h.fromPeer(channel.ready());
  assert.equal(h.client.isPaired, true);
  assert.equal(h.registry.get(device.publicKey)?.transport, 2);
  // The queued broadcast follows the capabilities.
  assert.deepEqual(h.received(channel), [
    { type: "server_capabilities", transport: { version: 2 }, seenAs: 2 },
    { type: "session_list", sessions: [] },
  ]);

  h.fromPeer(channel.seal({ type: "list_sessions" }));
  assert.deepEqual(h.delivered.map((message) => message.type), ["list_sessions"]);
  assert.equal(channelKindForMessage(h.delivered[0]), "v2");
  assert.equal(h.client.transportOfKey(device.publicKey), 2);

  // What the handshake replaced is never acted on from a v2 channel, so the
  // token cannot reach the old gate this way.
  const before = h.frames.length;
  h.fromPeer(channel.seal({ type: "device_auth", token: "token", name: "Renamed", platform: "android" }));
  h.fromPeer(channel.seal({ type: "client_capabilities", binaryEnvelope: true }));
  assert.equal(h.frames.length, before);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.registry.get(device.publicKey)?.name, "Pixel 9");

  // A removed device on v2 is told nothing. Its channel just stops.
  assert.equal(h.client.dropPeersWithKey(device.publicKey, "removed"), 1);
  assert.equal(h.frames.length, before);
  h.fromPeer(channel.seal({ type: "list_sessions" }));
  assert.equal(h.delivered.length, 1);
});

test("a device under a previous secret gets pairing_update before server_capabilities", () => {
  const h = harness();
  const first = h.device();
  h.fromPeer(h.handshake(first).ready());
  const oldSecret = h.registry.currentSecret().secret;
  const current = h.registry.rotateSecret();

  const again = h.device({ keys: first.keys, secret: oldSecret });
  const channel = h.handshake(again, "phone-2");
  h.fromPeer(channel.ready(), "phone-2");
  assert.deepEqual(h.received(channel, "phone-2"), [
    { type: "pairing_update", secret: current.secret, roomId: ROOM_ID },
    { type: "server_capabilities", transport: { version: 2 }, seenAs: 2 },
  ]);
  assert.equal(h.registry.get(first.publicKey)?.secretId, current.id);
});

test("an unsealed frame after the handshake drops the peer", () => {
  const h = harness();
  const channel = h.handshake(h.device());
  h.fromPeer(channel.ready());
  const before = h.frames.length;

  h.fromPeer(JSON.stringify({ type: "list_sessions" }));
  assert.equal(h.client.isPaired, false);
  assert.equal(h.delivered.length, 0);
  // Nothing after that counts, sealed or not.
  h.fromPeer(channel.seal({ type: "list_sessions" }));
  assert.equal(h.delivered.length, 0);
  assert.equal(h.frames.length, before, "a dropped peer is told nothing");
});

test("a record whose counter does not increase drops the peer", () => {
  const h = harness();
  const channel = h.handshake(h.device());
  h.fromPeer(channel.ready());
  const record = channel.seal({ type: "list_sessions" });
  h.fromPeer(record);
  assert.equal(h.delivered.length, 1);

  h.fromPeer(record);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.client.isPaired, false);
  h.fromPeer(channel.seal({ type: "list_sessions" }));
  assert.equal(h.delivered.length, 1);
});

test("a first record that is not transport_ready drops the peer and stores nothing", () => {
  const h = harness();
  const device = h.device();
  const channel = h.handshake(device);
  h.fromPeer(channel.seal({ type: "list_sessions" }));
  h.fromPeer(channel.ready());
  assert.equal(h.client.isPaired, false);
  assert.equal(h.delivered.length, 0);
  assert.equal(h.registry.get(device.publicKey), undefined);
  assert.equal(h.frames.length, 1);

  // A binary frame in the same place is the same.
  const other = h.device();
  const binary = h.handshake(other, "phone-2");
  h.client.handleRelayMessage({
    type: "relay_peer_message", peerId: "phone-2", binary: true,
    data: binary.channel.sealBinary(Buffer.from("J{\"type\":\"transport_ready\"}")).toString("base64"),
  });
  h.fromPeer(binary.ready(), "phone-2");
  assert.equal(h.registry.get(other.publicKey), undefined);
  assert.equal(h.client.isPaired, false);
});

test("one handshake per peer: a second hs1 is ignored, and so is anything oversized or of another version", () => {
  const h = harness();
  const device = h.device();
  const channel = h.handshake(device);
  h.fromPeer(h.device().hs1);
  h.fromPeer(device.hs1);
  assert.equal(h.frames.length, 1, "a second hs1 gets no second hs2");
  h.fromPeer(channel.ready());
  assert.equal(h.client.isPaired, true, "and does not disturb the first");

  // A peer whose hs1 got silence cannot try again on the same connection.
  const wrong = h.device({ secret: Buffer.alloc(32, 3).toString("base64") });
  h.fromPeer(wrong.hs1, "phone-2");
  h.fromPeer(h.device().hs1, "phone-2");
  assert.equal(h.frames.filter((frame) => frame.peerId === "phone-2").length, 0);

  // Another version spends nothing: the peer may still send the one this side speaks.
  const later = h.device();
  h.fromPeer(JSON.stringify({ ...parseJsonObject(later.hs1), v: 3 }), "phone-3");
  h.fromPeer(JSON.stringify({ type: "hs1", v: 2, pad: "x".repeat(5000) }), "phone-3");
  assert.equal(h.frames.filter((frame) => frame.peerId === "phone-3").length, 0);
  h.fromPeer(later.hs1, "phone-3");
  assert.equal(h.frames.filter((frame) => frame.peerId === "phone-3").length, 1);

  // A v2 peer cannot turn into an old-path one.
  const stuck = h.device({ secret: Buffer.alloc(32, 3).toString("base64") });
  h.fromPeer(stuck.hs1, "phone-4");
  h.fromPeer(JSON.stringify({ type: "key_exchange", pubkey: stuck.publicKey }), "phone-4");
  assert.equal(h.frames.filter((frame) => frame.peerId === "phone-4").length, 0);
});

test("a low-order key in hs1 gets no answer", () => {
  const h = harness();
  const frame = parseHs1Frame(h.device().hs1);
  assert.ok(frame);
  h.fromPeer(encodeHs1Frame({ ...frame, message: Buffer.concat([Buffer.alloc(32), frame.message.subarray(32)]) }));
  assert.deepEqual(h.frames, []);
});

test("a locked computer holds a new key until a paired device allows it", () => {
  const h = harness();
  h.registry.lock();
  const device = h.device({ payload: { app: "1.2.0", name: "Laptop", platform: "macos", caps: {} } });
  const channel = h.handshake(device);
  assert.equal(channel.answer.status, "pending");
  assert.deepEqual(h.prompts, [], "nobody is asked before transport_ready");

  h.fromPeer(channel.ready());
  assert.deepEqual(h.prompts, [{ publicKey: device.publicKey, name: "Laptop", platform: "macos", code: channel.code }]);
  assert.equal(h.client.isKeyPending(device.publicKey), true);
  assert.equal(h.client.isPaired, false);
  assert.equal(h.registry.get(device.publicKey), undefined);

  // A held peer's records are ignored and broadcasts do not reach it.
  h.fromPeer(channel.seal({ type: "list_sessions" }));
  h.client.send({ type: "status", running: false });
  assert.equal(h.delivered.length, 0);
  assert.equal(h.frames.length, 1);

  // device_approve: the index records the key, then opens the held peers.
  h.registry.enroll({ publicKey: device.publicKey, kind: "device", name: "Laptop", platform: "macos", via: "approval" });
  assert.equal(h.client.approvePeersWithKey(device.publicKey), 1);
  assert.deepEqual(h.received(channel).map((message) => message.type), ["device_auth_result", "server_capabilities", "status"]);
  assert.equal(h.registry.get(device.publicKey)?.transport, 2);
  h.fromPeer(channel.seal({ type: "list_sessions" }));
  assert.equal(h.delivered.length, 1);
});

test("a denied or departed held peer frees its place and clears the prompt", () => {
  const h = harness();
  h.registry.lock();
  const denied = h.device();
  const channel = h.handshake(denied);
  h.fromPeer(channel.ready());
  // device_deny.
  assert.equal(h.client.dropPeersWithKey(denied.publicKey, "not_approved"), 1);
  assert.deepEqual(h.received(channel), [{ type: "device_auth_result", ok: false, reason: "not_approved" }]);
  assert.deepEqual(h.cleared, [denied.publicKey]);

  const gone = h.device();
  h.fromPeer(h.handshake(gone, "phone-2").ready(), "phone-2");
  h.client.handleRelayMessage({ type: "peer_disconnected", peerId: "phone-2" });
  assert.deepEqual(h.cleared, [denied.publicKey, gone.publicKey]);
  assert.equal(h.registry.list().length, 0);
});

test("the bulk lane opens a recorded device and refuses a key control would add", () => {
  const h = harness("bulk");
  const stranger = h.handshake(h.device());
  assert.equal(stranger.answer.status, "refused");
  assert.equal(stranger.answer.reason, "not_approved");
  h.fromPeer(stranger.ready());
  assert.equal(h.client.isPaired, false);

  const keys = generateKeyPair();
  h.registry.enroll({ publicKey: Buffer.from(keys.publicKey).toString("base64"), kind: "device", name: "Pixel", platform: "android", via: "token", transport: 2 });
  const channel = h.handshake(h.device({ keys }), "phone-2");
  h.fromPeer(channel.ready(), "phone-2");
  assert.deepEqual(h.received(channel, "phone-2"), [{ type: "server_capabilities", transport: { version: 2 }, seenAs: 2 }]);

  // A removed device's bulk channel stops in the same call, as on control.
  h.fromPeer(channel.seal({ type: "list_sessions" }), "phone-2");
  assert.equal(h.delivered.length, 1);
  assert.equal(h.client.dropPeersWithKey(Buffer.from(keys.publicKey).toString("base64"), "removed"), 1);
  h.fromPeer(channel.seal({ type: "list_sessions" }), "phone-2");
  assert.equal(h.delivered.length, 1);
});

test("the relay client joins new-style, proves it owns the room, and never falls back to an old-style join", { timeout: 10_000 }, async (t) => {
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const ownerKey = nacl.sign.keyPair();
  const roomId = "room with spaces/and+signs";
  const nonce = Buffer.alloc(32, 9);
  /** @type {{ url: string | undefined, headers: import("node:http").IncomingHttpHeaders }[]} */
  const joins = [];
  /** @type {string[]} */
  const firstFrames = [];
  let finish = () => {};
  /** @type {Promise<void>} */
  const closed = new Promise((resolve) => { finish = () => resolve(undefined); });
  relay.on("connection", (socket, request) => {
    joins.push({ url: request.url, headers: request.headers });
    socket.send(JSON.stringify({ type: "relay_challenge", nonce: nonce.toString("base64") }));
    socket.once("message", (data) => {
      firstFrames.push(String(data));
      // Another key owns the room.
      socket.send(JSON.stringify({ type: "relay_error", error: "owner_mismatch" }));
      socket.close(4004);
    });
    socket.on("close", () => finish());
  });

  const client = new RelayClient({
    relayUrl: `ws://127.0.0.1:${address.port}`, pairingToken: roomId, keyPair: generateKeyPair(), ownerKey,
    serverCapabilities: () => ({ type: "server_capabilities" }),
    onStatusChange() {},
  });
  t.after(() => client.close());
  client.connect();
  await closed;

  assert.equal(joins[0].url, "/", "the room ID is not in the URL");
  assert.equal(joins[0].headers["x-socketagent-protocol"], "2");
  assert.equal(joins[0].headers["x-socketagent-role"], "server");
  assert.equal(joins[0].headers["x-socketagent-room"], encodeURIComponent(roomId));
  assert.equal(joins[0].headers["x-socketagent-owner-key"], Buffer.from(ownerKey.publicKey).toString("base64"));

  // The first frame after the challenge is relay_auth, signed over the label, the room and the nonce.
  const auth = parseJsonObject(firstFrames[0]);
  assert.equal(auth.type, "relay_auth");
  const signed = Buffer.concat([Buffer.from("socketagent-relay-auth-v1\0", "ascii"), Buffer.from(roomId, "utf8"), Buffer.of(0), nonce]);
  assert.deepEqual(relayAuthMessage(roomId, nonce), signed);
  assert.equal(nacl.sign.detached.verify(signed, Buffer.from(String(auth.sig), "base64"), ownerKey.publicKey), true);

  // After 4004 the next try is ten minutes away, not the usual second, and
  // no join of any other style is tried in between.
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(joins.length, 1);

  // Without the owner key there is no join at all.
  const keyless = new RelayClient({
    relayUrl: `ws://127.0.0.1:${address.port}`, pairingToken: roomId, keyPair: generateKeyPair(),
    serverCapabilities: () => ({ type: "server_capabilities" }), onStatusChange() {},
  });
  assert.throws(() => keyless.connect(), /owner key/);
  assert.equal(joins.length, 1);

  // `pair --reset` moves the computer to a new room. That join does not wait out the ten minutes.
  assert.equal(client.ownerMismatch, true);
  client.moveRoom("the-new-room");
  assert.equal(client.ownerMismatch, false);
  await once(relay, "connection");
  assert.equal(joins[1].headers["x-socketagent-room"], "the-new-room");
});
