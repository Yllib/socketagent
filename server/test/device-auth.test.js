const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { DeviceRegistry, deviceFingerprint } = require("#server/device-registry");
const { DeviceAuthGate } = require("#server/device-auth");
const { RelayClient } = require("#server/relay-client");
const { rotateAuthTokenInEnv } = require("#server/env-file");
const { generateKeyPair, encrypt, decrypt, toBase64 } = require("#server/relay-crypto");
const { parseJsonObject } = require("#server/value-guards");

const AUTH_TOKEN = "correct-horse-battery-staple";
let counter = 0;

function registryFile() {
  return path.join(dataDir, `devices-${++counter}.json`);
}

/**
 * A relay client with a fake open socket. Every frame meant for a peer is
 * captured instead of sent, so tests can see exactly what a peer receives.
 * @param {InstanceType<typeof DeviceRegistry>} registry
 * @param {"control" | "bulk" | "link"} lane
 * @param {Partial<ConstructorParameters<typeof RelayClient>[0]>} extra
 */
function harness(registry, lane = "control", extra = {}) {
  const serverKeys = generateKeyPair();
  /** @type {{peerId: string, data: string}[]} */
  const frames = [];
  /** @type {unknown[]} */
  const delivered = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: "room",
    keyPair: serverKeys,
    lane,
    peerAuth: new DeviceAuthGate(registry, () => AUTH_TOKEN),
    serverCapabilities: () => ({ type: "server_capabilities" }),
    onMessage: (msg) => delivered.push(msg),
    onStatusChange: () => {},
    ...extra,
  });
  client.sendRawFrameToPeer = (peerId, data, _binary) => {
    frames.push({ peerId, data: String(data) });
  };
  client.ws = { readyState: 1 };
  return { client, frames, delivered, serverKeys };
}

/**
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
 * @param {ReturnType<typeof harness>} h
 * @param {ReturnType<typeof generateKeyPair>} peerKeys
 * @param {Record<string, unknown>} message
 */
function sendEncrypted(h, peerKeys, message, peerId = "phone-1") {
  const envelope = encrypt(JSON.stringify(message), h.serverKeys.publicKey, peerKeys.secretKey);
  h.client.handlePeerMessage({ n: envelope.n, c: envelope.c }, peerId);
}

test("enforced mode holds an unknown key and sends it nothing but device_auth replies", () => {
  const registry = new DeviceRegistry(registryFile(), true);
  assert.equal(registry.mode, "enforced");
  const h = harness(registry);
  const phone = generateKeyPair();

  h.client.handlePeerMessage({ type: "key_exchange", pubkey: toBase64(phone.publicKey) }, "phone-1");
  assert.deepEqual(framesFor(h, phone), [{ encrypted: false, type: "key_exchange_ack", device: "pending" }]);
  assert.equal(h.client.isPaired, false);

  // Broadcasts and replies never reach a held peer.
  h.client.send({ type: "session_list", sessions: [] });
  h.client.sendReply("phone-1", { type: "status", running: false });
  assert.equal(h.frames.length, 1);

  // Anything other than device_auth gets one not_approved reply and no dispatch.
  sendEncrypted(h, phone, { type: "list_sessions" });
  assert.deepEqual(framesFor(h, phone).at(-1), { encrypted: true, type: "device_auth_result", ok: false, reason: "not_approved" });
  assert.equal(h.delivered.length, 0);
  assert.equal(registry.get(toBase64(phone.publicKey)), undefined);
});

test("the token enrolls only inside the encrypted box", () => {
  const registry = new DeviceRegistry(registryFile(), true);
  const h = harness(registry);
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  h.client.handlePeerMessage({ type: "key_exchange", pubkey: key }, "phone-1");
  h.client.send({ type: "session_list", sessions: [] });

  // Plaintext device_auth is not a key exchange and not an envelope: ignored.
  h.client.handlePeerMessage({ type: "device_auth", token: AUTH_TOKEN, name: "Pixel", platform: "android" }, "phone-1");
  assert.equal(registry.get(key), undefined);
  assert.equal(h.frames.length, 1);

  sendEncrypted(h, phone, { type: "device_auth", token: "wrong", name: "Pixel", platform: "android" });
  const refused = framesFor(h, phone).at(-1);
  assert.equal(refused?.ok, false);
  assert.equal(refused?.reason, "approval_required");
  assert.equal(refused?.code, deviceFingerprint(key));
  assert.equal(registry.get(key), undefined);

  sendEncrypted(h, phone, { type: "device_auth", token: AUTH_TOKEN, name: "Pixel", platform: "android" });
  const frames = framesFor(h, phone);
  assert.deepEqual(frames.at(-2), { encrypted: true, type: "device_auth_result", ok: true });
  // The queued broadcast flushes only once the peer is open.
  assert.equal(frames.at(-1)?.type, "session_list");
  assert.equal(registry.get(key)?.via, "token");
  assert.equal(registry.get(key)?.name, "Pixel");
  assert.equal(h.client.isPaired, true);

  // Now ordinary messages reach the handler.
  sendEncrypted(h, phone, { type: "list_sessions" });
  assert.equal(h.delivered.length, 1);
});

test("learning mode enrolls every key that finishes the handshake", () => {
  const registry = new DeviceRegistry(registryFile(), false);
  assert.equal(registry.mode, "learning");
  const h = harness(registry);
  const phone = generateKeyPair();
  h.client.handlePeerMessage({ type: "key_exchange", pubkey: toBase64(phone.publicKey) }, "phone-1");
  assert.deepEqual(framesFor(h, phone), [{ encrypted: false, type: "key_exchange_ack", device: "approved" }]);
  assert.equal(registry.get(toBase64(phone.publicKey))?.via, "migration");
  registry.lock();
  assert.equal(registry.mode, "enforced");
  assert.equal(parseJsonObject(fs.readFileSync(registry.filePath, "utf8")).mode, "enforced");
});

test("revoked keys stay out of migration and token enrollment", () => {
  const file = registryFile();
  const registry = new DeviceRegistry(file, false);
  const phone = generateKeyPair();
  const key = toBase64(phone.publicKey);
  registry.enroll({ publicKey: key, kind: "device", name: "Old phone", platform: "android", via: "token" });
  registry.revoke(key);
  assert.equal(registry.isRevoked(key), true);

  const learning = harness(registry);
  learning.client.handlePeerMessage({ type: "key_exchange", pubkey: key }, "phone-1");
  assert.equal(framesFor(learning, phone)[0]?.device, "pending");
  sendEncrypted(learning, phone, { type: "device_auth", token: AUTH_TOKEN, name: "Old phone", platform: "android" });
  assert.equal(framesFor(learning, phone).at(-1)?.reason, "approval_required");
  assert.equal(registry.get(key), undefined);

  // Only an explicit approval brings it back.
  registry.enroll({ publicKey: key, kind: "device", name: "Old phone", platform: "android", via: "approval" });
  assert.equal(registry.isRevoked(key), false);
  assert.equal(learning.client.approvePeersWithKey(key), 1);
  assert.deepEqual(framesFor(learning, phone).at(-1), { encrypted: true, type: "device_auth_result", ok: true });
  assert.equal(learning.client.isPaired, true);
});

test("removing a device rotates the token and the old token no longer enrolls", () => {
  const envPath = path.join(dataDir, `env-${++counter}`);
  fs.writeFileSync(envPath, "PORT=1\nAUTH_TOKEN=old-token\nRELAY_URL=wss://x\n");
  let current = "old-token";
  const registry = new DeviceRegistry(registryFile(), true);
  const gate = new DeviceAuthGate(registry, () => current);
  const keeper = toBase64(generateKeyPair().publicKey);
  const removed = toBase64(generateKeyPair().publicKey);
  registry.enroll({ publicKey: keeper, kind: "device", name: "Keeper", platform: "android", via: "token" });
  registry.enroll({ publicKey: removed, kind: "device", name: "Gone", platform: "android", via: "token" });

  registry.revoke(removed);
  current = rotateAuthTokenInEnv(envPath);
  assert.notEqual(current, "old-token");
  const env = fs.readFileSync(envPath, "utf8");
  assert.match(env, new RegExp(`^AUTH_TOKEN=${current}$`, "m"));
  assert.doesNotMatch(env, /old-token/);
  assert.match(env, /^PORT=1$/m);
  assert.match(env, /^RELAY_URL=wss:\/\/x$/m);

  // The removed device re-enrolling with its old token, under a fresh key, is refused.
  const fresh = toBase64(generateKeyPair().publicKey);
  const outcome = gate.deviceAuth(fresh, "control", { token: "old-token", name: "Gone", platform: "android" });
  assert.equal(outcome.ok, false);
  assert.equal(registry.get(fresh), undefined);
  assert.equal(gate.deviceAuth(fresh, "control", { token: current, name: "New", platform: "android" }).ok, true);
});

test("computer keys are refused on the phone lanes and device keys on the link lane", () => {
  const registry = new DeviceRegistry(registryFile(), true);
  const gate = new DeviceAuthGate(registry, () => AUTH_TOKEN);
  const computer = generateKeyPair();
  const device = generateKeyPair();
  const computerKey = toBase64(computer.publicKey);
  const deviceKey = toBase64(device.publicKey);
  registry.enroll({ publicKey: computerKey, kind: "computer", name: "Desktop", platform: "computer", via: "link",
    access: { read: true, agents: true, commands: true }, confirm: "never" });
  registry.enroll({ publicKey: deviceKey, kind: "device", name: "Pixel", platform: "android", via: "token" });

  assert.equal(gate.authorize(computerKey, "control"), "refused");
  assert.equal(gate.authorize(computerKey, "bulk"), "refused");
  assert.equal(gate.authorize(computerKey, "link"), "approved");
  assert.equal(gate.authorize(deviceKey, "link"), "refused");
  assert.equal(gate.authorize(deviceKey, "control"), "approved");
  assert.equal(gate.deviceAuth(computerKey, "control", { token: AUTH_TOKEN }).ok, false);
  assert.equal(gate.deviceAuth(deviceKey, "link", { token: AUTH_TOKEN }).ok, false);

  // On the wire: a computer key on the control lane is told wrong_lane and then ignored.
  const control = harness(registry, "control");
  control.client.handlePeerMessage({ type: "key_exchange", pubkey: computerKey }, "peer-1");
  assert.deepEqual(framesFor(control, computer), [
    { encrypted: false, type: "key_exchange_ack", device: "pending" },
    { encrypted: true, type: "device_auth_result", ok: false, reason: "wrong_lane" },
  ]);
  sendEncrypted(control, computer, { type: "device_auth", token: AUTH_TOKEN }, "peer-1");
  assert.equal(control.frames.length, 2);
  assert.equal(control.delivered.length, 0);

  // And a device key on the link lane never reaches the peer API.
  /** @type {unknown[]} */
  const peerJson = [];
  const link = harness(registry, "link", { onPeerJson: (msg) => peerJson.push(msg) });
  link.client.handlePeerMessage({ type: "key_exchange", pubkey: deviceKey }, "peer-1");
  assert.equal(framesFor(link, device).at(-1)?.reason, "wrong_lane");
  sendEncrypted(link, device, { type: "peer_request", id: "1", action: "hello", args: {} }, "peer-1");
  assert.deepEqual(peerJson, []);

  // The real computer key is welcome on the link lane.
  const link2 = harness(registry, "link", { onPeerJson: (msg) => peerJson.push(msg) });
  link2.client.handlePeerMessage({ type: "key_exchange", pubkey: computerKey }, "peer-2");
  assert.equal(framesFor(link2, computer)[0]?.device, "approved");
  sendEncrypted(link2, computer, { type: "peer_request", id: "1", action: "hello", args: {} }, "peer-2");
  assert.equal(peerJson.length, 1);
});

test("repeated wrong tokens close the peer", () => {
  const registry = new DeviceRegistry(registryFile(), true);
  const h = harness(registry);
  const phone = generateKeyPair();
  h.client.handlePeerMessage({ type: "key_exchange", pubkey: toBase64(phone.publicKey) }, "phone-1");
  for (let attempt = 0; attempt < 5; attempt++) {
    sendEncrypted(h, phone, { type: "device_auth", token: `wrong-${attempt}` });
    assert.equal(framesFor(h, phone).at(-1)?.reason, "approval_required");
  }
  sendEncrypted(h, phone, { type: "device_auth", token: "wrong-again" });
  assert.equal(framesFor(h, phone).at(-1)?.reason, "too_many_attempts");
  const before = h.frames.length;
  sendEncrypted(h, phone, { type: "device_auth", token: AUTH_TOKEN });
  assert.equal(h.frames.length, before);
  assert.equal(registry.get(toBase64(phone.publicKey)), undefined);
});
