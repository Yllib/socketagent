const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { DeviceRegistry } = require("#server/device-registry");
const { generateKeyPair } = require("#server/noise-ikpsk1");
const {
  admissionFor,
  MAX_FAILED_HS1_PER_ADDRESS,
  MAX_FAILED_HS1_PER_LANE,
  MAX_HELD_PEERS,
  MAX_PENDING_ANSWERS,
  TransportResponder,
} = require("#server/transport-responder");
const { encodeHs1Frame, parseHs1Frame, secretTag } = require("#server/transport-v2");
const { parseJsonObject } = require("#server/value-guards");
const { dial } = require("./v2-initiator");

const ROOM_ID = "ab".repeat(32);
const LINK_ROOM_ID = "cd".repeat(32);
let counter = 0;

/** A computer with an empty record, its responder, and what a device needs to dial it. */
function setup() {
  const file = path.join(dataDir, `responder-${++counter}.json`);
  const registry = new DeviceRegistry(file);
  const keyPair = generateKeyPair();
  let now = Date.now();
  /** @type {string[]} */
  const moved = [];
  const responder = new TransportResponder({
    registry, keyPair: () => keyPair, roomId: () => ROOM_ID, linkRoomId: () => LINK_ROOM_ID, serverVersion: "1.1.530",
    onDeviceMoved: (publicKey) => moved.push(publicKey), now: () => now,
  });
  /** @param {Partial<Parameters<typeof dial>[0]>} options */
  const device = (options = {}) => dial({ serverKey: keyPair.publicKey, secret: registry.currentSecret().secret, roomId: ROOM_ID, ...options });
  return { registry, responder, keyPair, device, moved, file, advance: (/** @type {number} */ ms) => { now += ms; } };
}

/** @param {ReturnType<typeof setup>} env */
function stateOnDisk(env) {
  return fs.readFileSync(env.file, "utf8");
}

/**
 * Runs one device's handshake up to `hs2` and reads the answer as the device.
 * @param {ReturnType<typeof setup>} env
 * @param {ReturnType<typeof dial>} device
 * @param {"control" | "bulk" | "link"} lane
 * @param {"relay" | "direct" | "local-request"} path
 */
function answer(env, device, lane = "control", path = "relay") {
  const outcome = env.responder.handleHs1(device.hs1, { path, lane });
  if (outcome.result === "silent") return { outcome, status: "silent" };
  const finished = device.finish(outcome.hs2);
  return { outcome, finished, status: String(finished.answer.status) };
}

/** @param {ReturnType<typeof setup>["registry"]} registry @param {string} publicKey */
function record(registry, publicKey) {
  registry.enroll({ publicKey, kind: "device", name: "Pixel", platform: "android", via: "token" });
}

test("the admission table of spec 7.3", () => {
  /** @type {[Parameters<typeof admissionFor>[0], ReturnType<typeof admissionFor>][]} */
  const rows = [
    // Rule 2: another kind of key, whatever it proves.
    [{ lane: "control", standing: "other-kind", fitted: "current", locked: false }, "silent"],
    [{ lane: "bulk", standing: "other-kind", fitted: "current", locked: false }, "silent"],
    // Rules 3 and 4.
    [{ lane: "control", standing: "device", fitted: "current", locked: true }, "open"],
    [{ lane: "control", standing: "device", fitted: "previous", locked: true }, "open-update"],
    [{ lane: "bulk", standing: "device", fitted: "current", locked: true }, "open"],
    [{ lane: "bulk", standing: "device", fitted: "previous", locked: true }, "open"],
    // Rules 5 and 6: a removed key asks again, locked or not.
    [{ lane: "control", standing: "removed", fitted: "current", locked: false }, "hold"],
    [{ lane: "control", standing: "removed", fitted: "current", locked: true }, "hold"],
    [{ lane: "control", standing: "removed", fitted: "previous", locked: false }, "silent"],
    // Rules 7 to 9.
    [{ lane: "control", standing: "unknown", fitted: "current", locked: false }, "add"],
    [{ lane: "control", standing: "unknown", fitted: "current", locked: true }, "hold"],
    [{ lane: "control", standing: "unknown", fitted: "previous", locked: false }, "silent"],
    // Bulk never adds or holds.
    [{ lane: "bulk", standing: "unknown", fitted: "current", locked: false }, "refuse"],
    [{ lane: "bulk", standing: "unknown", fitted: "current", locked: true }, "refuse"],
    [{ lane: "bulk", standing: "removed", fitted: "current", locked: false }, "refuse"],
    [{ lane: "bulk", standing: "removed", fitted: "previous", locked: false }, "silent"],
    [{ lane: "bulk", standing: "unknown", fitted: "previous", locked: false }, "silent"],
  ];
  for (const [input, expected] of rows) assert.equal(admissionFor(input), expected, JSON.stringify(input));
});

test("rule 7: an unknown key with the current secret is added at transport_ready, not before", () => {
  const env = setup();
  const device = env.device({ payload: { app: "1.2.0", name: `  ${"n".repeat(100)}  `, platform: "ios", caps: { binaryEnvelope: true } } });
  const before = stateOnDisk(env);
  const { outcome, status } = answer(env, device);
  assert.equal(status, "open");
  assert.equal(outcome.result, "answered");
  assert.equal(stateOnDisk(env), before, "hs1 stores nothing");
  if (outcome.result !== "answered") return;
  assert.deepEqual(outcome.handshake.caps, { binaryEnvelope: true });

  assert.deepEqual(env.responder.ready(outcome.handshake), { result: "open" });
  const entry = env.registry.get(device.publicKey);
  assert.equal(entry?.via, "token");
  assert.equal(entry?.transport, 2);
  assert.equal(entry?.platform, "ios");
  assert.equal(entry?.name, "n".repeat(80));
  assert.equal(entry?.secretId, env.registry.currentSecret().id);
  // One handshake reaches the state once.
  assert.deepEqual(env.responder.ready(outcome.handshake), { result: "closed" });
});

test("a replayed hs1 gets a fresh hs2 and changes no state", () => {
  const env = setup();
  const device = env.device();
  const before = stateOnDisk(env);
  const first = env.responder.handleHs1(device.hs1, { path: "relay", lane: "control" });
  const replay = env.responder.handleHs1(device.hs1, { path: "relay", lane: "control" });
  assert.equal(first.result, "answered");
  assert.equal(replay.result, "answered");
  if (first.result !== "answered" || replay.result !== "answered") return;
  assert.notEqual(replay.hs2, first.hs2, "each answer has its own ephemeral key");
  assert.equal(stateOnDisk(env), before);
  assert.equal(env.registry.get(device.publicKey), undefined);

  // Whoever replayed it cannot read hs2, so the keys of the two answers
  // differ and a record sealed for one does not open on the other.
  const real = device.finish(first.hs2);
  const sealed = parseJsonObject(real.ready());
  assert.throws(() => replay.handshake.channel.openText({ n: String(sealed.n), c: String(sealed.c) }), /did not open/);
  assert.equal(stateOnDisk(env), before);
});

test("rule 1: a wrong secret, an unknown tag and a frame for another place stay silent", () => {
  const env = setup();
  const wrongSecret = Buffer.alloc(32, 5).toString("base64");
  const before = stateOnDisk(env);
  assert.deepEqual(env.responder.handleHs1(env.device({ secret: wrongSecret }).hs1, { path: "relay", lane: "control" }), { result: "silent" });

  // The right tag on a handshake made with another secret: the tag is public, the PSK is not.
  const forged = parseHs1Frame(env.device({ secret: wrongSecret }).hs1);
  assert.ok(forged);
  const tag = secretTag(Buffer.from(env.registry.currentSecret().secret, "base64"));
  assert.deepEqual(env.responder.handleHs1(encodeHs1Frame({ ...forged, tag }), { path: "relay", lane: "control" }), { result: "silent" });

  // A good handshake that arrives on another path or lane than it names, or for another room.
  assert.deepEqual(env.responder.handleHs1(env.device().hs1, { path: "direct", lane: "control" }), { result: "silent" });
  assert.deepEqual(env.responder.handleHs1(env.device().hs1, { path: "relay", lane: "bulk" }), { result: "silent" });
  assert.deepEqual(env.responder.handleHs1(env.device({ roomId: "cd".repeat(32) }).hs1, { path: "relay", lane: "control" }), { result: "silent" });
  assert.deepEqual(env.responder.handleHs1("{}", { path: "relay", lane: "control" }), { result: "silent" });
  assert.equal(stateOnDisk(env), before);
  assert.deepEqual(env.registry.list(), []);
});

test("a zero or low-order key in hs1 is refused in silence", () => {
  const env = setup();
  const frame = parseHs1Frame(env.device().hs1);
  assert.ok(frame);
  // The initiator's ephemeral key is the first 32 bytes of Noise message 1.
  const lowOrder = [Buffer.alloc(32), Buffer.concat([Buffer.of(1), Buffer.alloc(31)])];
  for (const key of lowOrder) {
    const message = Buffer.concat([key, frame.message.subarray(32)]);
    assert.deepEqual(env.responder.handleHs1(encodeHs1Frame({ ...frame, message }), { path: "relay", lane: "control" }), { result: "silent" });
  }
  assert.deepEqual(env.registry.list(), []);
});

test("rule 2: a recorded computer or connector key is never answered on a device lane", () => {
  const env = setup();
  const computer = env.device();
  env.registry.enroll({ publicKey: computer.publicKey, kind: "computer", name: "Desktop", platform: "computer", via: "link",
    access: { read: true, agents: true, commands: true }, confirm: "never" });
  assert.equal(answer(env, computer).status, "silent");
  assert.equal(answer(env, env.device({ keys: computer.keys, lane: "bulk" }), "bulk").status, "silent");
  // Link handshakes are the next stage's work and get nothing yet.
  assert.deepEqual(env.responder.handleHs1(env.device({ lane: "link" }).hs1, { path: "relay", lane: "link" }), { result: "silent" });
});

test("rules 3 and 4: a recorded device opens, and under a previous secret is handed the current one", () => {
  const env = setup();
  const keys = generateKeyPair();
  const oldSecret = env.registry.currentSecret();
  const publicKey = Buffer.from(keys.publicKey).toString("base64");
  record(env.registry, publicKey);
  const current = env.registry.rotateSecret();

  // Rule 3, and the first v2 handshake of a device that was on the old path.
  const fresh = answer(env, env.device({ keys }));
  assert.equal(fresh.status, "open");
  assert.equal(fresh.outcome.result === "answered" && env.responder.ready(fresh.outcome.handshake).result, "open");
  assert.equal(env.registry.get(publicKey)?.transport, 2);
  assert.deepEqual(env.moved, [publicKey], "its old-path channels close now");

  // Rule 4 on control.
  const stale = answer(env, env.device({ keys, secret: oldSecret.secret }));
  assert.equal(stale.status, "open");
  assert.ok(stale.outcome.result === "answered");
  assert.deepEqual(env.responder.ready(stale.outcome.handshake), {
    result: "open", pairingUpdate: { type: "pairing_update", secret: current.secret, roomId: ROOM_ID },
  });
  assert.equal(env.registry.get(publicKey)?.secretId, current.id);
  assert.deepEqual(env.moved, [publicKey], "a device already on v2 does not move again");

  // The bulk lane opens under the previous secret too, with no pairing_update.
  const bulk = answer(env, env.device({ keys, secret: oldSecret.secret, lane: "bulk" }), "bulk");
  assert.ok(bulk.outcome.result === "answered");
  assert.deepEqual(env.responder.ready(bulk.outcome.handshake), { result: "open" });
});

test("rules 5 and 6: a removed key waits for Allow with the current secret and gets nothing with a previous one", () => {
  const env = setup();
  const keys = generateKeyPair();
  const publicKey = Buffer.from(keys.publicKey).toString("base64");
  const oldSecret = env.registry.currentSecret();
  record(env.registry, publicKey);
  env.registry.revoke(publicKey);
  env.registry.rotateSecret();
  assert.equal(env.registry.locked, false);

  assert.equal(answer(env, env.device({ keys, secret: oldSecret.secret })).status, "silent");
  const held = answer(env, env.device({ keys }));
  assert.equal(held.status, "pending", "an unlocked computer still asks about a removed key");
  assert.ok(held.outcome.result === "answered");
  assert.equal(env.responder.ready(held.outcome.handshake).result, "held");
  assert.equal(env.registry.isRevoked(publicKey), true, "the removed list changes on Allow, not before");
  assert.equal(answer(env, env.device({ keys, lane: "bulk" }), "bulk").status, "refused");
});

test("rule 8: a locked computer holds a new key until a paired device allows it", () => {
  const env = setup();
  env.registry.lock();
  const device = env.device({ payload: { app: "1.2.0", name: "Laptop", platform: "macos", caps: {} } });
  const { outcome, finished, status } = answer(env, device);
  assert.equal(status, "pending");
  assert.ok(outcome.result === "answered" && finished);
  assert.equal(env.responder.heldCount, 1);

  const ready = env.responder.ready(outcome.handshake);
  assert.deepEqual(ready, { result: "held", notice: { publicKey: device.publicKey, name: "Laptop", platform: "macos", code: finished.code } });
  assert.match(finished.code, /^\d{6}$/);
  assert.equal(env.registry.get(device.publicKey), undefined, "a held key is not recorded");

  // Allow before the index has recorded the key does nothing.
  assert.equal(env.responder.approve(outcome.handshake), null);
  assert.equal(env.responder.heldCount, 0);
});

test("an allowed key is marked v2 and told about a secret that changed while it waited", () => {
  const env = setup();
  env.registry.lock();
  const device = env.device();
  const { outcome } = answer(env, device);
  assert.ok(outcome.result === "answered");
  env.responder.ready(outcome.handshake);

  const current = env.registry.rotateSecret();
  env.registry.enroll({ publicKey: device.publicKey, kind: "device", name: "Pixel 9", platform: "android", via: "approval" });
  assert.deepEqual(env.responder.approve(outcome.handshake), { pairingUpdate: { type: "pairing_update", secret: current.secret, roomId: ROOM_ID } });
  assert.equal(env.registry.get(device.publicKey)?.transport, 2);
  assert.equal(env.registry.get(device.publicKey)?.secretId, current.id);
});

test("rule 9 and the bulk lane: no previous secret for an unknown key, no adding or holding on bulk", () => {
  const env = setup();
  const oldSecret = env.registry.currentSecret();
  env.registry.rotateSecret();
  assert.equal(answer(env, env.device({ secret: oldSecret.secret })).status, "silent");

  const bulk = answer(env, env.device({ lane: "bulk" }), "bulk");
  assert.equal(bulk.status, "refused");
  assert.equal(bulk.finished?.answer.reason, "not_approved");
  assert.deepEqual(env.registry.list(), []);
});

test("state that changed between hs2 and transport_ready closes the handshake", () => {
  const env = setup();
  const opened = answer(env, env.device());
  assert.ok(opened.outcome.result === "answered");
  env.registry.lock();
  assert.deepEqual(env.responder.ready(opened.outcome.handshake), { result: "closed" });
  assert.deepEqual(env.registry.list(), []);

  const other = setup();
  const stale = answer(other, other.device());
  assert.ok(stale.outcome.result === "answered");
  other.registry.resetPairing();
  assert.deepEqual(other.responder.ready(stale.outcome.handshake), { result: "closed" });
  assert.deepEqual(other.registry.list(), []);
});

test("an unreadable state file answers nobody", () => {
  const file = path.join(dataDir, `responder-unreadable-${++counter}.json`);
  fs.writeFileSync(file, "not json");
  const registry = new DeviceRegistry(file);
  const keyPair = generateKeyPair();
  const responder = new TransportResponder({ registry, keyPair: () => keyPair, roomId: () => ROOM_ID, serverVersion: "1.1.530" });
  const device = dial({ serverKey: keyPair.publicKey, secret: Buffer.alloc(32, 1).toString("base64"), roomId: ROOM_ID });
  assert.deepEqual(responder.handleHs1(device.hs1, { path: "relay", lane: "control" }), { result: "silent" });
});

test("limits: eight held peers and thirty pending answers in ten minutes", () => {
  const env = setup();
  env.registry.lock();
  /** @type {import("#server/transport-responder").AcceptedHandshake[]} */
  const held = [];
  for (let index = 0; index < MAX_HELD_PEERS; index++) {
    const { outcome, status } = answer(env, env.device());
    assert.equal(status, "pending");
    if (outcome.result === "answered") held.push(outcome.handshake);
  }
  const ninth = answer(env, env.device());
  assert.equal(ninth.status, "refused");
  assert.equal(ninth.finished?.answer.reason, "too_many_pending");

  // A place frees when a held peer goes away, until the ten-minute budget is spent.
  for (let given = MAX_HELD_PEERS; given < MAX_PENDING_ANSWERS; given++) {
    env.responder.release(held[0]);
    const { outcome, status } = answer(env, env.device());
    assert.equal(status, "pending");
    if (outcome.result === "answered") held[0] = outcome.handshake;
  }
  env.responder.release(held[0]);
  assert.equal(answer(env, env.device()).finished?.answer.reason, "too_many_pending");
  env.advance(10 * 60 * 1000 + 1);
  assert.equal(answer(env, env.device()).status, "pending");
});

test("failed hs1 frames: twenty a minute shut out one direct address, and a lane is skipped only at the cap that bounds the work", () => {
  const env = setup();
  const tag = secretTag(Buffer.from(env.registry.currentSecret().secret, "base64"));
  /** An hs1 anyone can make: the public tag of the current secret over a handshake under another secret. */
  const bad = (/** @type {"relay" | "direct"} */ path) => {
    const frame = parseHs1Frame(env.device({ path, secret: Buffer.alloc(32, 5).toString("base64") }).hs1);
    assert.ok(frame);
    return encodeHs1Frame({ ...frame, tag });
  };
  /** A good handshake on a direct socket from [remoteAddress]. */
  const direct = (/** @type {string} */ remoteAddress) => {
    const device = env.device({ path: "direct" });
    const outcome = env.responder.handleHs1(device.hs1, { path: "direct", lane: "control", remoteAddress });
    return outcome.result === "silent" ? "silent" : String(device.finish(outcome.hs2).answer.status);
  };

  // One address on the network sends twenty frames that fail.
  for (let attempt = 0; attempt < MAX_FAILED_HS1_PER_ADDRESS; attempt++) {
    assert.equal(env.responder.handleHs1(bad("direct"), { path: "direct", lane: "control", remoteAddress: "192.168.1.66" }).result, "silent");
  }
  assert.equal(direct("192.168.1.66"), "silent", "that address is ignored for the rest of the minute");
  assert.equal(direct("192.168.1.20"), "open", "a good handshake from another address is not skipped");
  assert.equal(answer(env, env.device()).status, "open", "nor is one over the relay");
  env.advance(60 * 1000);
  assert.equal(direct("192.168.1.66"), "open", "the address is heard again in the next minute");

  // Every program on this computer shares the loopback address, so it has no count of its own.
  for (let attempt = 0; attempt < MAX_FAILED_HS1_PER_ADDRESS + 5; attempt++) {
    env.responder.handleHs1(bad("direct"), { path: "direct", lane: "control", remoteAddress: "127.0.0.1" });
  }
  assert.equal(direct("127.0.0.1"), "open");

  // In a relay room there is no address to count. Twenty failures, which once shut the lane, change nothing.
  env.advance(60 * 1000);
  for (let attempt = 0; attempt < MAX_FAILED_HS1_PER_ADDRESS; attempt++) env.responder.handleHs1(bad("relay"), { path: "relay", lane: "control" });
  assert.equal(answer(env, env.device()).status, "open");
  // Nor do ten a second for a whole minute, which was once enough: a recorded device still gets in.
  const recorded = env.device();
  const first = answer(env, recorded);
  assert.ok(first.outcome.result === "answered");
  assert.deepEqual(env.responder.ready(first.outcome.handshake), { result: "open" });
  assert.equal(env.registry.get(recorded.publicKey)?.kind, "device");
  const oneFrame = bad("relay");
  for (let attempt = MAX_FAILED_HS1_PER_ADDRESS; attempt < 600; attempt++) env.responder.handleHs1(oneFrame, { path: "relay", lane: "control" });
  assert.equal(answer(env, env.device({ keys: recorded.keys })).status, "open");
  // The work in a minute is still bounded. At the cap the lane is skipped until the minute ends.
  assert.ok(MAX_FAILED_HS1_PER_LANE >= 10_000);
  for (let attempt = 600; attempt < MAX_FAILED_HS1_PER_LANE; attempt++) env.responder.handleHs1(oneFrame, { path: "relay", lane: "control" });
  assert.equal(answer(env, env.device({ keys: recorded.keys })).status, "silent");
  assert.equal(direct("192.168.1.20"), "open", "another path is not held back");
  env.advance(60 * 1000);
  assert.equal(answer(env, env.device()).status, "open");
});

/** A linked computer's record, as `device_authorize` writes it. @param {ReturnType<typeof setup>} env */
function linkedComputer(env, extra = {}) {
  const keys = generateKeyPair();
  const publicKey = Buffer.from(keys.publicKey).toString("base64");
  const linkSecret = Buffer.alloc(32, ++counter).toString("base64");
  env.registry.enroll({
    publicKey, kind: "computer", name: "Dev VM", platform: "computer", via: "link",
    access: { read: true, agents: false, commands: false }, confirm: "never", linkSecret, ...extra,
  });
  /** @param {Partial<Parameters<typeof dial>[0]>} options */
  const source = (options = {}) => env.device({ keys, secret: linkSecret, roomId: LINK_ROOM_ID, lane: "link", payload: { app: "1.1.530" }, ...options });
  return { keys, publicKey, linkSecret, source };
}

test("an hs1 that meets a link past its time writes nothing, and the timer's prune saves the change", () => {
  const env = setup();
  const expired = linkedComputer(env, { expiresAt: Date.now() - 1 });
  let changes = 0;
  env.registry.onChange(() => { changes++; });
  const before = stateOnDisk(env);
  assert.ok(before.includes(expired.publicKey));

  // Anyone can send these. Each makes the responder read the registry.
  assert.equal(answer(env, expired.source(), "link").status, "silent");
  assert.equal(answer(env, env.device()).status, "open");
  assert.equal(env.registry.get(expired.publicKey), undefined, "a read no longer sees the link");
  assert.equal(stateOnDisk(env), before, "and no read wrote the file");
  assert.equal(changes, 0, "or told a listener");

  assert.equal(env.registry.pruneExpired(), true);
  assert.equal(stateOnDisk(env).includes(expired.publicKey), false);
  assert.equal(changes, 1);
  assert.equal(env.registry.pruneExpired(), false, "nothing more to save");
});

test("the link lane opens for a recorded computer that proves its link secret, and moves it at transport_ready", () => {
  const env = setup();
  const computer = linkedComputer(env);
  const before = stateOnDisk(env);
  const first = answer(env, computer.source(), "link");
  assert.equal(first.status, "open");
  // A replayed hs1 gets the same answer and changes nothing.
  assert.equal(stateOnDisk(env), before);
  assert.equal(env.registry.get(computer.publicKey)?.transport, 1);
  assert.equal(first.outcome.result, "answered");
  if (first.outcome.result !== "answered") return;

  assert.deepEqual(env.responder.ready(first.outcome.handshake), { result: "open" });
  assert.equal(env.registry.get(computer.publicKey)?.transport, 2);
  assert.deepEqual(env.moved, [computer.publicKey]);

  // A secret that was replaced between hs2 and transport_ready closes the handshake.
  const stale = answer(env, computer.source(), "link");
  env.registry.enroll({ publicKey: computer.publicKey, kind: "computer", name: "Dev VM", platform: "computer", via: "link", linkSecret: Buffer.alloc(32, 250).toString("base64") });
  assert.equal(stale.outcome.result, "answered");
  if (stale.outcome.result === "answered") assert.deepEqual(env.responder.ready(stale.outcome.handshake), { result: "closed" });
});

test("the link lane stays silent for everything but that computer and that secret", () => {
  const env = setup();
  const computer = linkedComputer(env);
  const pairingSecret = env.registry.currentSecret().secret;

  // The pairing secret, another computer's link secret, and the right secret under an unknown key.
  assert.equal(answer(env, computer.source({ secret: pairingSecret }), "link").status, "silent");
  const other = linkedComputer(env);
  assert.equal(answer(env, computer.source({ secret: other.linkSecret }), "link").status, "silent");
  assert.equal(answer(env, computer.source({ keys: generateKeyPair() }), "link").status, "silent");
  // The link secret is no way onto a device lane, and a link frame counts only in the link room.
  assert.equal(answer(env, computer.source({ roomId: ROOM_ID, lane: "control" }), "control").status, "silent");
  assert.equal(answer(env, computer.source(), "control").status, "silent");
  assert.equal(env.responder.handleHs1(computer.source().hs1, { path: "direct", lane: "link" }).result, "silent");

  // A computer with no link secret, an expired link, a device key and a removed computer.
  const plain = generateKeyPair();
  const plainKey = Buffer.from(plain.publicKey).toString("base64");
  env.registry.enroll({ publicKey: plainKey, kind: "computer", name: "Old link", platform: "computer", via: "link" });
  assert.equal(answer(env, computer.source({ keys: plain }), "link").status, "silent");
  const expired = linkedComputer(env, { expiresAt: Date.now() - 1 });
  assert.equal(answer(env, expired.source(), "link").status, "silent");
  const device = generateKeyPair();
  record(env.registry, Buffer.from(device.publicKey).toString("base64"));
  assert.equal(answer(env, computer.source({ keys: device }), "link").status, "silent");
  env.registry.revoke(other.publicKey);
  assert.equal(answer(env, other.source(), "link").status, "silent");

  assert.equal(answer(env, computer.source(), "link").status, "open");
});

test("local-request hands a recorded device the secret and makes every other key wait for Allow", () => {
  const env = setup();
  /** @param {Partial<Parameters<typeof dial>[0]>} options */
  const local = (options = {}) => env.device({ path: "local-request", ...options });

  // A recorded device: open, and the grant counts as handing it the current secret.
  const known = local();
  record(env.registry, known.publicKey);
  env.registry.rotateSecret();
  const opened = answer(env, known, "control", "local-request");
  assert.equal(opened.status, "open");
  assert.equal(opened.outcome.result, "answered");
  if (opened.outcome.result !== "answered") return;
  assert.equal(env.registry.get(known.publicKey)?.secretId, undefined);
  assert.deepEqual(env.responder.ready(opened.outcome.handshake), { result: "open" });
  const entry = env.registry.get(known.publicKey);
  assert.equal(entry?.secretId, env.registry.currentSecret().id);
  assert.equal(entry?.transport, 1, "the record moves when the device comes back with a direct handshake");

  // An unknown key waits even though the computer is not locked, and nothing is stored for it.
  assert.equal(env.registry.locked, false);
  const stranger = local({ payload: { app: "1.2.0", name: "Second account", platform: "windows", caps: {} } });
  const held = answer(env, stranger, "control", "local-request");
  assert.equal(held.status, "pending");
  assert.equal(held.outcome.result, "answered");
  if (held.outcome.result !== "answered" || !held.finished) return;
  assert.deepEqual(env.responder.ready(held.outcome.handshake), {
    result: "held", notice: { publicKey: stranger.publicKey, name: "Second account", platform: "windows", code: held.finished.code },
  });
  assert.equal(env.registry.get(stranger.publicKey), undefined);
  // Allow: the index records the key, then the responder marks the secret as handed.
  env.registry.enroll({ publicKey: stranger.publicKey, kind: "device", name: "Second account", platform: "windows", via: "approval" });
  assert.deepEqual(env.responder.approve(held.outcome.handshake), {});
  assert.equal(env.registry.get(stranger.publicKey)?.secretId, env.registry.currentSecret().id);
  assert.equal(env.registry.get(stranger.publicKey)?.transport, 1);

  // A removed key asks again. A linked computer's key is not a device and gets nothing.
  env.registry.revoke(known.publicKey);
  assert.equal(answer(env, local({ keys: known.keys }), "control", "local-request").status, "pending");
  const computer = linkedComputer(env);
  assert.equal(answer(env, local({ keys: computer.keys }), "control", "local-request").status, "silent");
  // The path is its own: the same frame is not a direct or relay handshake, and bulk does not exist on it.
  assert.equal(env.responder.handleHs1(local().hs1, { path: "direct", lane: "control" }).result, "silent");
  assert.equal(env.responder.handleHs1(local().hs1, { path: "local-request", lane: "bulk" }).result, "silent");
});

test("local-request answers nobody while the state file is unreadable", () => {
  const env = setup();
  fs.writeFileSync(env.file, "{ damaged");
  const registry = new DeviceRegistry(env.file);
  const responder = new TransportResponder({ registry, keyPair: () => env.keyPair, roomId: () => ROOM_ID, serverVersion: "1.1.530" });
  assert.equal(responder.handleHs1(env.device({ path: "local-request", secret: Buffer.alloc(32).toString("base64") }).hs1, { path: "local-request", lane: "control" }).result, "silent");
});
