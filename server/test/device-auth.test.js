const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { DeviceRegistry } = require("#server/device-registry");
const { DeviceAuthGate } = require("#server/device-auth");
const { channelKindForMessage, RelayClient } = require("#server/relay-client");
const { rotateAuthTokenInEnv } = require("#server/env-file");
const { SessionKeyedPeerStore, SessionOffer, decrypt, encrypt, generateKeyPair, toBase64 } = require("#server/relay-crypto");
const { TransportResponder } = require("#server/transport-responder");
const { isRecord, parseJsonObject } = require("#server/value-guards");
const { dial } = require("./v2-initiator");

// The old path under the lid, wire spec section 9: what a computer on this
// build still accepts from an app that has not moved to transport v2, and
// what it now refuses.

const AUTH_TOKEN = "correct-horse-battery-staple";
const ROOM_ID = "ab".repeat(32);
let counter = 0;

function registryFile() {
  return path.join(dataDir, `devices-${++counter}.json`);
}

/** A computer that has just updated: its state comes from the devices.json the old build wrote. */
function migratedRegistry(/** @type {{ mode: "learning" | "enforced", devices?: string[], revoked?: string[] }} */ old) {
  const legacy = registryFile();
  fs.writeFileSync(legacy, JSON.stringify({
    version: 1, mode: old.mode, revoked: old.revoked ?? [],
    devices: (old.devices ?? []).map((publicKey) => ({
      publicKey, kind: "device", name: "Pixel", platform: "android", addedAt: "2026-10-01", lastSeenAt: "2026-10-01", via: "migration",
    })),
  }));
  return new DeviceRegistry(registryFile(), legacy);
}

/**
 * A relay client with a fake open socket. Every frame meant for a peer is
 * captured instead of sent, so tests can see exactly what a peer receives.
 * @param {InstanceType<typeof DeviceRegistry>} registry
 * @param {"control" | "bulk" | "link"} lane
 * @param {Partial<ConstructorParameters<typeof RelayClient>[0]>} extra
 */
function harness(registry, lane = "control", extra = {}) {
  const serverKeys = extra.keyPair ?? generateKeyPair();
  /** @type {{peerId: string, data: string}[]} */
  const frames = [];
  /** @type {import("#server/protocol").ClientMessage[]} */
  const delivered = [];
  /** @type {string[]} */
  const prompts = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: ROOM_ID,
    keyPair: serverKeys,
    lane,
    peerAuth: new DeviceAuthGate(registry, () => AUTH_TOKEN),
    serverCapabilities: (_binary, _lane, _key, transport) => ({ type: "server_capabilities", transport: { version: 2 }, seenAs: transport }),
    onMessage: (msg) => delivered.push(msg),
    onDevicePending: (notice) => prompts.push(notice.publicKey),
    onStatusChange: () => {},
    ...extra,
  });
  client.sendRawFrameToPeer = (peerId, data, _binary) => {
    frames.push({ peerId, data: String(data) });
  };
  client.ws = { readyState: 1 };
  return { client, frames, delivered, prompts, serverKeys };
}

/**
 * A frame from a peer, the way the relay hands it over.
 * @param {ReturnType<typeof harness>} h
 * @param {unknown} frame
 */
function fromPeer(h, frame, peerId = "phone-1") {
  h.client.handleRelayMessage({ type: "relay_peer_message", peerId, binary: false, data: JSON.stringify(frame) });
}

/**
 * What the peer received, opened with the static box where it is sealed.
 * @param {ReturnType<typeof harness>} h
 * @param {ReturnType<typeof generateKeyPair>} peerKeys
 */
function framesFor(h, peerKeys) {
  return h.frames.map((frame) => {
    const parsed = parseJsonObject(frame.data);
    if (typeof parsed.n === "string" && typeof parsed.c === "string") {
      const inner = parseJsonObject(decrypt({ n: parsed.n, c: parsed.c }, h.serverKeys.publicKey, peerKeys.secretKey));
      return { encrypted: true, ...inner };
    }
    return { encrypted: false, ...parsed };
  });
}

/**
 * An app from before session keys: `key_exchange` with only its public key,
 * then static-box frames.
 * @param {ReturnType<typeof harness>} h
 * @param {ReturnType<typeof generateKeyPair>} peerKeys
 * @param {Record<string, unknown>} message
 */
function sendEncrypted(h, peerKeys, message, peerId = "phone-1") {
  fromPeer(h, encrypt(JSON.stringify(message), h.serverKeys.publicKey, peerKeys.secretKey), peerId);
}

/**
 * What app 1.1.3 does when the relay says a computer is there: one
 * `key_exchange` with a session offer, then sealed frames on the session
 * keys the ack agrees.
 * @param {ReturnType<typeof harness>} h
 * @param {ReturnType<typeof generateKeyPair>} peerKeys
 */
function sessionExchange(h, peerKeys, peerId = "phone-1") {
  const offer = new SessionOffer(peerKeys, h.serverKeys.publicKey);
  const before = h.frames.length;
  fromPeer(h, offer.message(), peerId);
  const ack = h.frames.slice(before).map((frame) => parseJsonObject(frame.data)).find((frame) => frame.type === "key_exchange_ack");
  assert.ok(ack, "the computer acks the key exchange");
  const channel = offer.accept(ack, new SessionKeyedPeerStore());
  return {
    ack,
    channel,
    /** @param {Record<string, unknown>} message */
    send: (message) => fromPeer(h, channel.sealText(JSON.stringify(message)), peerId),
    /** Opens every sealed frame the peer got since the exchange. */
    received: () => h.frames.slice(before).filter((frame) => frame.peerId === peerId).flatMap((frame) => {
      const parsed = parseJsonObject(frame.data);
      return typeof parsed.n === "string" && typeof parsed.c === "string"
        ? [parseJsonObject(channel.openText({ n: parsed.n, c: parsed.c }))]
        : [];
    }),
  };
}

test("9.1: a device paired before the update gets in with what app 1.1.3 sends, with nothing for its user to do", () => {
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  // The hard case: the computer was locked, so nothing new would be let in.
  const registry = migratedRegistry({ mode: "enforced", devices: [key] });
  const h = harness(registry);

  const peer = sessionExchange(h, phone);
  assert.equal(peer.ack.device, "approved");
  assert.equal(peer.channel.sessionKeyed, true);
  peer.send({ type: "client_capabilities", lane: "control", binaryEnvelope: false, sessionKeyVersion: 1 });
  assert.deepEqual(peer.received(), [{ type: "server_capabilities", transport: { version: 2 }, seenAs: 1 }]);
  assert.equal(h.client.isPaired, true);

  peer.send({ type: "list_sessions" });
  assert.deepEqual(h.delivered.map((message) => message.type), ["list_sessions"]);
  assert.equal(channelKindForMessage(h.delivered[0]), "session");
  assert.equal(registry.get(key)?.transport, 1, "the old path never marks a device as moved");
  assert.deepEqual(h.prompts, []);
});

test("9.1: an app from before session keys still gets in with the static box", () => {
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  const registry = migratedRegistry({ mode: "learning", devices: [key] });
  const h = harness(registry);

  fromPeer(h, { type: "key_exchange", pubkey: key });
  assert.deepEqual(framesFor(h, phone), [{ encrypted: false, type: "key_exchange_ack", device: "approved" }]);
  sendEncrypted(h, phone, { type: "list_sessions" });
  assert.equal(h.delivered.length, 1);
  // 9.2.10 keys on this: pairing_upgrade is answered on a session-keyed channel only.
  assert.equal(channelKindForMessage(h.delivered[0]), "static");
});

test("9.1 and 9.2.4: an unknown key gets in by the token inside the box and by nothing else", () => {
  const registry = migratedRegistry({ mode: "learning" });
  const h = harness(registry);

  // No learning-mode enrollment: finishing the key exchange records nothing.
  const quiet = generateKeyPair();
  fromPeer(h, { type: "key_exchange", pubkey: toBase64(quiet.publicKey) }, "peer-quiet");
  assert.deepEqual(framesFor(h, quiet), [{ encrypted: false, type: "key_exchange_ack", device: "pending" }]);
  assert.equal(registry.get(toBase64(quiet.publicKey)), undefined);
  // Broadcasts and replies never reach a held peer.
  h.client.send({ type: "session_list", sessions: [] });
  h.client.sendReply("peer-quiet", { type: "status", running: false });
  assert.equal(h.frames.length, 1);
  // device_auth with no token: told once, dropped, and nobody is asked to approve it.
  sendEncrypted(h, quiet, { type: "device_auth", name: "Pixel", platform: "android" }, "peer-quiet");
  assert.deepEqual(framesFor(h, quiet).at(-1), { encrypted: true, type: "device_auth_result", ok: false, reason: "not_approved" });
  const afterRefusal = h.frames.length;
  sendEncrypted(h, quiet, { type: "device_auth", token: AUTH_TOKEN, name: "Pixel", platform: "android" }, "peer-quiet");
  assert.equal(h.frames.length, afterRefusal, "a dropped peer is ignored until it leaves");
  assert.deepEqual(h.prompts, []);
  assert.equal(registry.get(toBase64(quiet.publicKey)), undefined);

  // A wrong token is the same answer.
  const wrong = generateKeyPair();
  h.frames.length = 0;
  fromPeer(h, { type: "key_exchange", pubkey: toBase64(wrong.publicKey) }, "peer-wrong");
  sendEncrypted(h, wrong, { type: "device_auth", token: "wrong", name: "Pixel", platform: "android" }, "peer-wrong");
  assert.deepEqual(framesFor(h, wrong).at(-1), { encrypted: true, type: "device_auth_result", ok: false, reason: "not_approved" });
  assert.equal(registry.get(toBase64(wrong.publicKey)), undefined);

  // The right token, sealed: recorded as an old-path device and opened.
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  h.frames.length = 0;
  fromPeer(h, { type: "key_exchange", pubkey: key }, "peer-phone");
  sendEncrypted(h, phone, { type: "device_auth", token: AUTH_TOKEN, name: "Pixel", platform: "android" }, "peer-phone");
  const frames = framesFor(h, phone);
  assert.deepEqual(frames[1], { encrypted: true, type: "device_auth_result", ok: true });
  // The queued broadcast flushes only once the peer is open.
  assert.equal(frames.at(-1)?.type, "session_list");
  assert.equal(registry.get(key)?.via, "token");
  assert.equal(registry.get(key)?.transport, 1);
  assert.equal(registry.get(key)?.name, "Pixel");
  sendEncrypted(h, phone, { type: "list_sessions" }, "peer-phone");
  assert.equal(h.delivered.length, 1);
  assert.deepEqual(h.prompts, []);
});

test("9.2.5: over the relay a locked computer refuses an unknown key, token or not", () => {
  const registry = migratedRegistry({ mode: "enforced" });
  const h = harness(registry);
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);

  fromPeer(h, { type: "key_exchange", pubkey: key });
  sendEncrypted(h, phone, { type: "device_auth", token: AUTH_TOKEN, name: "Pixel", platform: "android" });
  assert.deepEqual(framesFor(h, phone), [
    { encrypted: false, type: "key_exchange_ack", device: "pending" },
    { encrypted: true, type: "device_auth_result", ok: false, reason: "not_approved" },
  ]);
  assert.equal(registry.get(key), undefined);
  assert.deepEqual(h.prompts, []);

});

test("a direct e2e=1 socket with the right token gets in on a locked computer, from any address", () => {
  // The old build never recorded a device that only connected this way, so
  // the lock must not shut out one that is paired today.
  const registry = migratedRegistry({ mode: "enforced" });
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);
  const [lan, local, wrong, bare] = [0, 1, 2, 3].map(() => toBase64(generateKeyPair().publicKey));

  assert.deepEqual(gate.directAuth(lan, { token: AUTH_TOKEN, name: "Pixel", platform: "android" }, false), { ok: true, enrolled: true });
  assert.deepEqual([registry.get(lan)?.via, registry.get(lan)?.transport], ["token", 1]);
  assert.deepEqual(gate.directAuth(local, { token: AUTH_TOKEN, name: "Desktop app", platform: "linux" }, true), { ok: true, enrolled: true });
  // The token is still what gets it in.
  assert.deepEqual(gate.directAuth(wrong, { token: "wrong" }, false), { ok: false, reason: "not_approved", close: true });
  assert.deepEqual(gate.directAuth(bare, {}, false), { ok: false, reason: "not_approved", close: true });
  assert.equal(registry.get(wrong), undefined);
  assert.equal(registry.get(bare), undefined);
  // Over the relay the same token on the same locked computer is refused.
  const relayKey = toBase64(generateKeyPair().publicKey);
  assert.deepEqual(gate.deviceAuth(relayKey, "control", { token: AUTH_TOKEN }), { ok: false, reason: "not_approved", close: true });
});

test("9.2.2 and 9.2.3: a removed key and a key that has moved to v2 are refused the old path", () => {
  const [removed, moved] = [generateKeyPair(), generateKeyPair()];
  const registry = migratedRegistry({ mode: "learning", devices: [toBase64(moved.publicKey)], revoked: [toBase64(removed.publicKey)] });
  registry.touch(toBase64(moved.publicKey), { transport: 2 });
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);

  const h = harness(registry);
  fromPeer(h, { type: "key_exchange", pubkey: toBase64(removed.publicKey) }, "peer-removed");
  assert.deepEqual(framesFor(h, removed), [
    { encrypted: false, type: "key_exchange_ack", device: "pending" },
    { encrypted: true, type: "device_auth_result", ok: false, reason: "removed" },
  ]);
  // The token does not bring a removed key back.
  sendEncrypted(h, removed, { type: "device_auth", token: AUTH_TOKEN }, "peer-removed");
  assert.equal(h.frames.length, 2);
  assert.equal(registry.isRevoked(toBase64(removed.publicKey)), true);
  assert.deepEqual(gate.directAuth(toBase64(removed.publicKey), { token: AUTH_TOKEN }, true), { ok: false, reason: "removed", close: true });

  h.frames.length = 0;
  fromPeer(h, { type: "key_exchange", pubkey: toBase64(moved.publicKey) }, "peer-moved");
  assert.deepEqual(framesFor(h, moved), [
    { encrypted: false, type: "key_exchange_ack", device: "pending" },
    { encrypted: true, type: "device_auth_result", ok: false, reason: "not_approved" },
  ]);
  sendEncrypted(h, moved, { type: "list_sessions" }, "peer-moved");
  assert.equal(h.delivered.length, 0);
  assert.deepEqual(gate.directAuth(toBase64(moved.publicKey), { token: AUTH_TOKEN }, true), { ok: false, reason: "not_approved", close: true });
});

test("9.2.1: a key of the wrong length or of low order gets no ack, static or session", () => {
  const registry = migratedRegistry({ mode: "learning" });
  const h = harness(registry);
  const lowOrder = [Buffer.alloc(32), Buffer.concat([Buffer.of(1), Buffer.alloc(31)])];
  for (const [index, key] of [...lowOrder, Buffer.alloc(31, 7)].entries()) {
    fromPeer(h, { type: "key_exchange", pubkey: key.toString("base64") }, `peer-${index}`);
  }
  // A sound static key with a low-order session key.
  const phone = generateKeyPair();
  const offer = new SessionOffer(phone, h.serverKeys.publicKey).message();
  assert.ok(isRecord(offer.session));
  for (const [index, key] of lowOrder.entries()) {
    fromPeer(h, { ...offer, session: { ...offer.session, key: key.toString("base64") } }, `peer-session-${index}`);
  }
  assert.deepEqual(h.frames, []);
  assert.deepEqual(registry.list(), []);
});

test("9.2.6: an unsealed frame after a key exchange drops the peer, and a repeated key_exchange does not", () => {
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  const registry = migratedRegistry({ mode: "learning", devices: [key] });
  const h = harness(registry);

  // The one frame app 1.1.3 sends unsealed by design is key_exchange, again
  // each time the relay reports the computer.
  sessionExchange(h, phone).send({ type: "list_sessions" });
  const again = sessionExchange(h, phone);
  assert.equal(again.ack.device, "approved");
  again.send({ type: "list_sessions" });
  assert.equal(h.delivered.length, 2);

  // The token in the clear, or any other unsealed frame, ends it.
  fromPeer(h, { type: "device_auth", token: AUTH_TOKEN, name: "Pixel", platform: "android" });
  assert.equal(h.client.isPaired, false);
  const before = h.frames.length;
  again.send({ type: "list_sessions" });
  assert.equal(h.delivered.length, 2);
  assert.equal(h.frames.length, before);
});

test("9.1: the lanes keep their kinds of key", () => {
  const registry = migratedRegistry({ mode: "enforced" });
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);
  const computer = generateKeyPair();
  const device = generateKeyPair();
  const computerKey = toBase64(computer.publicKey);
  const deviceKey = toBase64(device.publicKey);
  registry.enroll({ publicKey: computerKey, kind: "computer", name: "Desktop", platform: "computer", via: "link",
    access: { read: true, agents: true, commands: true }, confirm: "never" });
  registry.enroll({ publicKey: deviceKey, kind: "device", name: "Pixel", platform: "android", via: "token" });

  assert.deepEqual(gate.authorize(computerKey, "control"), { admission: "refused", reason: "wrong_lane" });
  assert.deepEqual(gate.authorize(computerKey, "bulk"), { admission: "refused", reason: "wrong_lane" });
  assert.deepEqual(gate.authorize(computerKey, "link"), { admission: "approved" });
  assert.deepEqual(gate.authorize(deviceKey, "link"), { admission: "refused", reason: "wrong_lane" });
  assert.deepEqual(gate.authorize(deviceKey, "control"), { admission: "approved" });
  assert.equal(gate.deviceAuth(computerKey, "control", { token: AUTH_TOKEN }).ok, false);
  assert.equal(gate.deviceAuth(deviceKey, "link", { token: AUTH_TOKEN }).ok, false);
  assert.deepEqual(gate.directAuth(computerKey, { token: AUTH_TOKEN }, false), { ok: false, reason: "wrong_lane", close: true });

  // On the wire: a computer key on the control lane is told wrong_lane and then ignored.
  const control = harness(registry, "control");
  fromPeer(control, { type: "key_exchange", pubkey: computerKey }, "peer-1");
  assert.deepEqual(framesFor(control, computer), [
    { encrypted: false, type: "key_exchange_ack", device: "pending" },
    { encrypted: true, type: "device_auth_result", ok: false, reason: "wrong_lane" },
  ]);
  sendEncrypted(control, computer, { type: "device_auth", token: AUTH_TOKEN }, "peer-1");
  assert.equal(control.frames.length, 2);
  assert.equal(control.delivered.length, 0);

  // A device key on the link lane never reaches the peer API, and a recorded
  // computer key still does.
  /** @type {unknown[]} */
  const peerJson = [];
  const link = harness(registry, "link", { onPeerJson: (msg) => peerJson.push(msg) });
  fromPeer(link, { type: "key_exchange", pubkey: deviceKey }, "peer-1");
  assert.equal(framesFor(link, device).at(-1)?.reason, "wrong_lane");
  sendEncrypted(link, device, { type: "peer_request", id: "1", action: "hello", args: {} }, "peer-1");
  assert.deepEqual(peerJson, []);
  const link2 = harness(registry, "link", { onPeerJson: (msg) => peerJson.push(msg) });
  fromPeer(link2, { type: "key_exchange", pubkey: computerKey }, "peer-2");
  assert.equal(framesFor(link2, computer)[0]?.device, "approved");
  sendEncrypted(link2, computer, { type: "peer_request", id: "1", action: "hello", args: {} }, "peer-2");
  assert.equal(peerJson.length, 1);
});

test("9.1: a direct socket needs a recorded key or the token, and only this computer may ask for approval", () => {
  const registry = migratedRegistry({ mode: "learning" });
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);
  const [recorded, stranger, tokenHolder] = [generateKeyPair(), generateKeyPair(), generateKeyPair()].map((keys) => toBase64(keys.publicKey));
  registry.enroll({ publicKey: recorded, kind: "device", name: "Pixel", platform: "android", via: "approval" });

  assert.deepEqual(gate.directAuth(recorded, { name: "Pixel", platform: "android" }, false), { ok: true, enrolled: false });
  assert.deepEqual(gate.directAuth(tokenHolder, { token: AUTH_TOKEN, name: "Tablet", platform: "android" }, false), { ok: true, enrolled: true });
  assert.equal(registry.get(tokenHolder)?.via, "token");
  // A stranger on the network is closed without an approval prompt.
  assert.deepEqual(gate.directAuth(stranger, { name: "Laptop" }, false), { ok: false, reason: "not_approved", close: true });
  assert.equal(registry.get(stranger), undefined);
  // From this computer the same key asks for approval, for the old desktop
  // app under another Windows account.
  const local = gate.directAuth(stranger, { name: "kayla on Desktop", platform: "windows" }, true);
  assert.equal(local.ok === false && local.reason, "approval_required");
  assert.equal(local.ok === false && local.notify?.name, "kayla on Desktop");
});

test("an unreadable state file lets in nobody but this computer's own tools with the token", () => {
  const file = registryFile();
  fs.writeFileSync(file, "{ not json");
  const registry = new DeviceRegistry(file);
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);
  const key = toBase64(generateKeyPair().publicKey);
  assert.deepEqual(gate.authorize(key, "control"), { admission: "refused", reason: "not_approved" });
  assert.deepEqual(gate.deviceAuth(key, "control", { token: AUTH_TOKEN }), { ok: false, reason: "not_approved", close: true });
  assert.deepEqual(gate.directAuth(key, { token: AUTH_TOKEN }, false), { ok: false, reason: "not_approved", close: true });
  assert.deepEqual(gate.directAuth(key, {}, true), { ok: false, reason: "not_approved", close: true });
  assert.deepEqual(gate.directAuth(key, { token: AUTH_TOKEN }, true), { ok: true, enrolled: false });
});

test("the wrong-token limit stays", () => {
  const registry = migratedRegistry({ mode: "learning" });
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);
  const key = toBase64(generateKeyPair().publicKey);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.deepEqual(gate.deviceAuth(key, "control", { token: `wrong-${attempt}` }), { ok: false, reason: "not_approved", close: true });
  }
  assert.deepEqual(gate.deviceAuth(key, "control", { token: "wrong-again" }), { ok: false, reason: "too_many_attempts", close: true });
  assert.equal(registry.get(key), undefined);
});

test("removing a device rotates the token and the old token no longer enrolls", () => {
  const envPath = path.join(dataDir, `env-${++counter}`);
  fs.writeFileSync(envPath, "PORT=1\nAUTH_TOKEN=old-token\nRELAY_URL=wss://x\n");
  let current = "old-token";
  const registry = migratedRegistry({ mode: "learning" });
  const gate = new DeviceAuthGate(registry, () => current);
  const removed = toBase64(generateKeyPair().publicKey);
  registry.enroll({ publicKey: removed, kind: "device", name: "Gone", platform: "android", via: "token" });

  registry.revoke(removed);
  current = rotateAuthTokenInEnv(envPath);
  assert.notEqual(current, "old-token");
  const env = fs.readFileSync(envPath, "utf8");
  assert.match(env, new RegExp(`^AUTH_TOKEN=${current}$`, "m"));
  assert.doesNotMatch(env, /old-token/);
  assert.match(env, /^PORT=1$/m);
  assert.match(env, /^RELAY_URL=wss:\/\/x$/m);

  // The removed device coming back with its old token, under a fresh key, is refused.
  const fresh = toBase64(generateKeyPair().publicKey);
  assert.equal(gate.deviceAuth(fresh, "control", { token: "old-token", name: "Gone", platform: "android" }).ok, false);
  assert.equal(registry.get(fresh), undefined);
  assert.equal(gate.deviceAuth(fresh, "control", { token: current, name: "New", platform: "android" }).ok, true);
});

test("the legacy switch off: a key exchange gets no answer in any room", () => {
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  const registry = migratedRegistry({ mode: "learning", devices: [key] });
  for (const lane of /** @type {const} */ (["control", "bulk", "link"])) {
    const h = harness(registry, lane, { legacyTransport: false });
    fromPeer(h, new SessionOffer(phone, h.serverKeys.publicKey).message());
    fromPeer(h, { type: "key_exchange", pubkey: key }, "phone-2");
    sendEncrypted(h, phone, { type: "list_sessions" }, "phone-2");
    assert.deepEqual(h.frames, []);
    assert.deepEqual(h.delivered, []);
  }
});

test("9.3: a device's first v2 transport_ready closes its old-path channels and bars it from that path", () => {
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  const registry = migratedRegistry({ mode: "enforced", devices: [key] });
  /** @type {ReturnType<typeof harness> | undefined} */
  let wired;
  const responderKeys = generateKeyPair();
  const responder = new TransportResponder({
    registry, keyPair: () => responderKeys, roomId: () => ROOM_ID, serverVersion: "1.1.530",
    // What the index does when a device moves.
    onDeviceMoved: (publicKey) => wired?.client.dropPeersWithKey(publicKey, "not_approved", "legacy"),
  });
  const h = harness(registry, "control", { keyPair: responderKeys, responder });
  wired = h;

  // Step 1 to 3: the old connection, on session keys, is where pairing_upgrade is asked.
  const old = sessionExchange(h, phone, "old-connection");
  old.send({ type: "pairing_upgrade", requestId: "r1" });
  assert.deepEqual(h.delivered.map((message) => [message.type, channelKindForMessage(message)]), [["pairing_upgrade", "session"]]);

  // Step 4 and 5: the app dials again with v2. Until its transport_ready the old channel stays.
  const device = dial({ serverKey: responderKeys.publicKey, secret: registry.currentSecret().secret, roomId: ROOM_ID, keys: phone });
  h.client.handleRelayMessage({ type: "relay_peer_message", peerId: "new-connection", binary: false, data: device.hs1 });
  const hs2 = h.frames.at(-1);
  assert.equal(hs2?.peerId, "new-connection");
  assert.equal(registry.get(key)?.transport, 1);
  assert.equal(h.client.transportOfKey(key), 1);
  const channel = device.finish(hs2?.data ?? "");
  assert.equal(channel.answer.status, "open", "a recorded device needs no Allow on a locked computer");
  h.client.handleRelayMessage({ type: "relay_peer_message", peerId: "new-connection", binary: false, data: channel.ready() });

  assert.equal(registry.get(key)?.transport, 2);
  assert.equal(h.client.transportOfKey(key), 2);
  assert.deepEqual(old.received().at(-1), { type: "device_auth_result", ok: false, reason: "not_approved" });
  old.send({ type: "list_sessions" });
  assert.equal(h.delivered.length, 1, "the old channel is closed");

  // 9.2.3 from here on.
  const back = sessionExchange(h, phone, "old-again");
  assert.equal(back.ack.device, "pending");
  assert.deepEqual(back.received(), [{ type: "device_auth_result", ok: false, reason: "not_approved" }]);
});
