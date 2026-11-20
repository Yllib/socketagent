const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { DeviceRegistry, MAX_KNOWN_PASS_KEYS, MAX_PREVIOUS_SECRETS, MAX_RETIRED_PASS_KEYS, PREVIOUS_SECRET_LIFETIME_MS } = require("#server/device-registry");
const { retiredPassKeysOf } = require("#server/account-pass");
const { generateKeyPair, toBase64 } = require("#server/relay-crypto");
const { isRecord, parseJsonObject, unknownArray } = require("#server/value-guards");

let counter = 0;

/** A fresh folder holding no state yet, as on the first start after the update. */
function paths() {
  const folder = path.join(dataDir, `registry-${++counter}`);
  fs.mkdirSync(folder);
  return { state: path.join(folder, "transport.json"), legacy: path.join(folder, "devices.json") };
}

function newKey() {
  return toBase64(generateKeyPair().publicKey);
}

/** @param {string} file */
function storedSecrets(file) {
  return unknownArray(parseJsonObject(fs.readFileSync(file, "utf8")).secrets).filter(isRecord);
}

test("the first start carries devices.json over and never reads it again", () => {
  const { state, legacy } = paths();
  const [phone, computer, removed] = [newKey(), newKey(), newKey()];
  fs.writeFileSync(legacy, JSON.stringify({
    // The old file may hold a removed key without its padding.
    version: 1, mode: "enforced", revoked: [removed.replace(/=+$/, "")],
    devices: [
      { publicKey: phone, kind: "device", name: "Pixel", platform: "android", addedAt: "2026-10-01", lastSeenAt: "2026-10-02", via: "token" },
      { publicKey: computer, kind: "computer", name: "Dev VM", platform: "computer", addedAt: "2026-10-01", lastSeenAt: "2026-10-01", via: "link",
        access: { read: true, agents: true, commands: false }, confirm: "per_chat" },
    ],
  }));

  const registry = new DeviceRegistry(state, legacy);
  assert.equal(registry.readable, true);
  assert.equal(registry.locked, true, "enforced mode becomes the lock");
  assert.equal(registry.get(phone)?.transport, 1);
  assert.equal(registry.get(phone)?.name, "Pixel");
  assert.equal(registry.get(computer)?.transport, 1);
  assert.equal(registry.get(computer)?.confirm, "ask");
  assert.equal(registry.isRevoked(removed), true);
  assert.equal(registry.currentSecret().id, 1);
  assert.equal(Buffer.from(registry.currentSecret().secret, "base64").length, 32);
  assert.deepEqual(registry.previousSecrets(), []);
  assert.equal(registry.relayOwnerKey().publicKey.length, 32);
  assert.equal(parseJsonObject(fs.readFileSync(state, "utf8")).version, 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(state).mode & 0o777, 0o600);

  // The next start reads transport.json only, whatever devices.json says by then.
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, mode: "learning", revoked: [], devices: [] }));
  const again = new DeviceRegistry(state, legacy);
  assert.equal(again.locked, true);
  assert.equal(again.get(phone)?.name, "Pixel");
  assert.equal(again.isRevoked(removed), true);
  assert.equal(again.currentSecret().secret, registry.currentSecret().secret);
});

test("a computer with no devices.json starts unlocked with an empty record", () => {
  const { state, legacy } = paths();
  const registry = new DeviceRegistry(state, legacy);
  assert.equal(registry.readable, true);
  assert.equal(registry.locked, false);
  assert.deepEqual(registry.list(), []);
  assert.equal(fs.existsSync(state), true);
});

test("a devices.json that does not parse leaves no state file and lets nobody in", () => {
  const { state, legacy } = paths();
  fs.writeFileSync(legacy, "{ not json");
  const registry = new DeviceRegistry(state, legacy);
  assert.equal(registry.readable, false);
  assert.match(registry.problem ?? "", /devices\.json/);
  assert.equal(registry.locked, true);
  assert.equal(fs.existsSync(state), false, "an empty state must not replace the lists it could not read");
  assert.throws(() => registry.currentSecret());
  assert.throws(() => registry.enroll({ publicKey: newKey(), kind: "device", name: "Pixel", platform: "android", via: "token" }));
});

test("an unreadable transport.json is not replaced until pairing is reset", () => {
  const { state, legacy } = paths();
  const known = newKey();
  // A devices.json beside it must not be used as a way back in.
  fs.writeFileSync(legacy, JSON.stringify({
    version: 1, mode: "learning", revoked: [],
    devices: [{ publicKey: known, kind: "device", name: "Pixel", platform: "android", addedAt: "2026-10-01", lastSeenAt: "2026-10-01", via: "token" }],
  }));
  fs.writeFileSync(state, JSON.stringify({ version: 2, locked: false, secrets: [] }));

  const registry = new DeviceRegistry(state, legacy);
  assert.equal(registry.readable, false);
  assert.equal(registry.locked, true);
  assert.equal(registry.get(known), undefined);
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.rotateSecret());
  assert.throws(() => registry.relayOwnerKey());

  registry.resetPairing();
  assert.equal(registry.readable, true);
  assert.equal(registry.locked, false);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.currentSecret().id, 1);
  assert.equal(fs.existsSync(`${state}.unreadable`), true, "the old file is kept beside the new one");
  assert.equal(new DeviceRegistry(state, legacy).readable, true);
});

test("reset keeps v2 devices and the removed list, deletes old-path device records, clears previous secrets and unlocks", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [phone, removed, oldPathPhone, linked] = [newKey(), newKey(), newKey(), newKey()];
  registry.enroll({ publicKey: phone, kind: "device", name: "Pixel", platform: "android", via: "token", transport: 2 });
  registry.enroll({ publicKey: oldPathPhone, kind: "device", name: "Old path", platform: "android", via: "migration" });
  registry.enroll({ publicKey: linked, kind: "computer", name: "Laptop", platform: "computer", via: "link" });
  registry.enroll({ publicKey: removed, kind: "device", name: "Old", platform: "android", via: "token" });
  registry.revoke(removed);
  registry.lock();
  const before = registry.rotateSecret();
  const ownerKey = toBase64(registry.relayOwnerKey().publicKey);

  registry.resetPairing();
  assert.equal(registry.locked, false);
  assert.notEqual(registry.currentSecret().secret, before.secret);
  assert.equal(registry.currentSecret().id, before.id + 1, "secret ids are never reused");
  assert.deepEqual(registry.previousSecrets(), []);
  assert.equal(registry.get(phone)?.transport, 2);
  // The old path lets a recorded key in with no token, so that record goes.
  // It is deleted, not removed: the device may pair again with the new token.
  assert.equal(registry.get(oldPathPhone), undefined);
  assert.equal(registry.isRevoked(oldPathPhone), false);
  assert.equal(registry.get(linked)?.kind, "computer", "a link is not a pairing and stays");
  assert.equal(registry.isRevoked(removed), true);
  assert.equal(toBase64(registry.relayOwnerKey().publicKey), ownerKey);
  assert.equal(new DeviceRegistry(state).get(oldPathPhone), undefined, "the deletion is saved");
});

test("a rotated secret stays honoured for 90 days, eight at most", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const first = registry.currentSecret();
  for (let round = 0; round < MAX_PREVIOUS_SECRETS + 2; round++) registry.rotateSecret();
  const previous = registry.previousSecrets();
  assert.equal(previous.length, MAX_PREVIOUS_SECRETS);
  assert.equal(registry.currentSecret().id, first.id + MAX_PREVIOUS_SECRETS + 2);
  assert.deepEqual(previous.map((secret) => secret.id), previous.map((secret) => secret.id).sort((a, b) => b - a), "newest first");
  assert.equal(previous.some((secret) => secret.id === first.id), false);

  // One previous secret passes its 90 days: it stops counting at once and
  // leaves the file on the next write.
  const stored = parseJsonObject(fs.readFileSync(state, "utf8"));
  const secrets = unknownArray(stored.secrets).filter(isRecord);
  const expiredId = secrets[1].id;
  secrets[1].retiredAt = new Date(Date.now() - PREVIOUS_SECRET_LIFETIME_MS - 1000).toISOString();
  fs.writeFileSync(state, JSON.stringify({ ...stored, secrets }));
  const reloaded = new DeviceRegistry(state);
  assert.equal(reloaded.previousSecrets().some((secret) => secret.id === expiredId), false);
  reloaded.lock();
  assert.equal(storedSecrets(state).some((secret) => secret.id === expiredId), false);
});

test("secretId only moves forward and never lands on a computer record", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [phone, computer] = [newKey(), newKey()];
  registry.enroll({ publicKey: phone, kind: "device", name: "Pixel", platform: "android", via: "token", secretId: 1 });
  registry.enroll({ publicKey: computer, kind: "computer", name: "Desktop", platform: "computer", via: "link",
    access: { read: true, agents: true, commands: true }, confirm: "never" });
  const next = registry.rotateSecret();
  registry.markSecretHanded([phone, computer, newKey()]);
  assert.equal(registry.get(phone)?.secretId, next.id);
  assert.equal(registry.get(computer)?.secretId, undefined);
  registry.touch(phone, { secretId: 1 });
  assert.equal(registry.get(phone)?.secretId, next.id);
});

/**
 * Records a v2 device, as a finished handshake does.
 * @param {InstanceType<typeof DeviceRegistry>} registry
 * @param {{ vouchedBy?: string }} [options]
 */
function recordedDevice(registry, options = {}) {
  const publicKey = newKey();
  registry.enroll({ publicKey, kind: "device", name: "Pixel", platform: "android", via: "token", transport: 2, ...options });
  return publicKey;
}

test("a pass key is trusted only while a recorded device carries it", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [account, other] = [newKey(), newKey()];
  const [phone, tablet] = [recordedDevice(registry), recordedDevice(registry)];

  assert.deepEqual(registry.registerPassKey(newKey(), account, []), { accepted: false, refusal: "unrecorded", dropped: [] }, "an unrecorded key registers nothing");
  assert.equal(registry.trustsPassKey(account), false);

  assert.equal(registry.registerPassKey(phone, account, []).accepted, true);
  assert.equal(registry.registerPassKey(tablet, account, []).accepted, true);
  assert.equal(registry.trustsPassKey(account), true);
  assert.deepEqual(registry.trustedPassKeys(), [{ passKey: account, devices: [phone, tablet] }]);
  assert.deepEqual(new DeviceRegistry(state).trustedPassKeys(), [{ passKey: account, devices: [phone, tablet] }], "kept across restarts");

  // A device carries one account. Moving to another drops its word for the first.
  registry.registerPassKey(tablet, other, []);
  assert.deepEqual(registry.trustedPassKeys(), [{ passKey: account, devices: [phone] }, { passKey: other, devices: [tablet] }]);

  registry.revoke(phone);
  assert.equal(registry.trustsPassKey(account), false, "removing the last device that carries the key ends the trust");
  assert.equal(registry.trustsPassKey(other), true);

  registry.resetPairing();
  assert.equal(registry.get(tablet)?.transport, 2);
  assert.deepEqual(registry.trustedPassKeys(), [], "reset trusts no account until one of its devices says so again");
});

test("a retired pass key is never trusted again and the records it vouched for are deleted", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [first, second] = [newKey(), newKey()];
  const phone = recordedDevice(registry);
  registry.registerPassKey(phone, first, []);
  const [tablet, laptop] = [recordedDevice(registry, { vouchedBy: first }), recordedDevice(registry, { vouchedBy: first })];
  registry.registerPassKey(tablet, first, []);

  // The phone came in by the pairing code and followed the account to a new
  // master key. Both records the old key vouched for go, without landing on
  // the removed list.
  assert.deepEqual(registry.registerPassKey(phone, second, [first]), { accepted: true, dropped: [tablet, laptop] });
  assert.equal(registry.get(tablet), undefined);
  assert.equal(registry.isRevoked(tablet), false);
  assert.equal(registry.isRevoked(laptop), false);
  assert.equal(registry.trustsPassKey(first), false);
  assert.deepEqual(registry.trustedPassKeys(), [{ passKey: second, devices: [phone] }]);

  // A device still holding the old key can't bring it back.
  assert.equal(registry.registerPassKey(phone, first, []).refusal, "retired");
  assert.equal(registry.trustsPassKey(first), false);
  assert.equal(registry.get(phone)?.passKey, second);

  const reloaded = new DeviceRegistry(state);
  assert.equal(reloaded.trustsPassKey(second), true);
  reloaded.resetPairing();
  assert.equal(reloaded.registerPassKey(phone, first, []).accepted, false, "a retired key stays retired after reset");
});

test("a pass key that only devices let in by a pass carry lets no key in", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [old, madeUp, next] = [newKey(), newKey(), newKey()];
  const phone = recordedDevice(registry);
  registry.registerPassKey(phone, old, []);
  // Both came in by a pass from the old key. The account has since retired
  // it, and the stranger's pass was a stale one.
  const [stranger, tablet] = [recordedDevice(registry, { vouchedBy: old }), recordedDevice(registry, { vouchedBy: old })];
  /** The pass keys this computer remembers for good, as saved. */
  const remembered = () => unknownArray(parseJsonObject(fs.readFileSync(state, "utf8")).passKeys).length;

  // The stranger reports the retirement itself, with a pass key it made up.
  assert.deepEqual(registry.registerPassKey(stranger, madeUp, [old]), { accepted: true, dropped: [] });
  assert.equal(registry.trustsPassKey(old), false, "the retirement counts whoever reports it");
  assert.equal(registry.get(stranger)?.passKey, madeUp);
  assert.equal(registry.trustsPassKey(madeUp), false);
  assert.deepEqual(registry.trustedPassKeys(), []);
  assert.equal(registry.get(tablet)?.vouchedBy, old, "it deletes nobody else's record");
  // More devices carrying the made-up key change nothing, and none of it
  // uses up the keys this computer remembers.
  registry.registerPassKey(tablet, madeUp, []);
  assert.equal(registry.trustsPassKey(madeUp), false);
  for (let count = 0; count < 5; count++) registry.registerPassKey(stranger, newKey(), []);
  assert.equal(remembered(), 1);

  // The tablet follows the account to its new key. That is not enough either:
  // the computer can't tell it from the stranger.
  assert.deepEqual(registry.registerPassKey(tablet, next, [old]), { accepted: true, dropped: [] });
  assert.equal(registry.trustsPassKey(next), false);

  // The phone came in by the pairing code. Its word makes the new key
  // trusted and deletes every record the old key vouched for, the stranger's
  // included. The tablet comes back with a pass from the new key.
  assert.deepEqual(registry.registerPassKey(phone, next, [old]), { accepted: true, dropped: [stranger, tablet] });
  assert.deepEqual(registry.trustedPassKeys(), [{ passKey: next, devices: [phone] }]);
  assert.equal(registry.isRevoked(tablet), false);
});

test("how a device got on record is settled when the record is made", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const account = newKey();
  const [phone, tablet] = [recordedDevice(registry), recordedDevice(registry, { vouchedBy: account })];
  /** @param {string} publicKey @param {string} [vouchedBy] */
  const approveAgain = (publicKey, vouchedBy) => registry.enroll({
    publicKey, kind: "device", name: "", platform: "android", via: "approval", ...(vouchedBy ? { vouchedBy } : {}),
  });

  assert.equal(approveAgain(tablet).vouchedBy, account, "approving it again does not clear the pass that let it in");
  assert.equal(approveAgain(phone, account).vouchedBy, undefined, "and puts no pass on a device that came in without one");
  assert.equal(approveAgain(tablet, newKey()).vouchedBy, account);
});

/**
 * Records a linked computer, as `device_authorize` does.
 * @param {InstanceType<typeof DeviceRegistry>} registry
 * @param {{ publicKey?: string, vouchedBy?: string }} [options]
 */
function linkedComputer(registry, options = {}) {
  return registry.enroll({
    publicKey: newKey(), kind: "computer", name: "Mac", platform: "computer", via: "link", transport: 2,
    access: { read: true, agents: false, commands: false }, confirm: "ask", ...options,
  });
}

test("a computer link made by a device a pass let in goes when the pass key is retired", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [old, next] = [newKey(), newKey()];
  const phone = recordedDevice(registry);
  registry.registerPassKey(phone, old, []);
  const laptop = recordedDevice(registry, { vouchedBy: old });
  const [marked, plain] = [linkedComputer(registry, { vouchedBy: old }), linkedComputer(registry)];
  assert.equal(marked.vouchedBy, old);

  // Linking a recorded computer again neither clears the mark nor adds one.
  assert.equal(linkedComputer(registry, { publicKey: marked.publicKey }).vouchedBy, old);
  assert.equal(linkedComputer(registry, { publicKey: plain.publicKey, vouchedBy: old }).vouchedBy, undefined);

  // The laptop's own report deletes nothing, its link included.
  assert.deepEqual(registry.registerPassKey(laptop, next, [old]).dropped, []);
  assert.equal(registry.get(marked.publicKey)?.kind, "computer");

  assert.deepEqual(registry.registerPassKey(phone, next, [old]).dropped, [laptop, marked.publicKey]);
  assert.equal(registry.get(marked.publicKey), undefined);
  assert.equal(registry.isRevoked(marked.publicKey), false, "the user can make the link again");
  assert.equal(registry.get(plain.publicKey)?.kind, "computer", "a link from a device that came in by the code stays");
});

test("reset deletes every record a pass put there and keeps the rest unmarked", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [account, gone] = [newKey(), newKey()];
  const phone = recordedDevice(registry);
  registry.registerPassKey(phone, account, []);
  const tablet = recordedDevice(registry, { vouchedBy: gone });
  const [marked, plain] = [linkedComputer(registry, { vouchedBy: gone }), linkedComputer(registry)];
  const client = registry.enroll({
    publicKey: newKey(), kind: "connector", name: "Claude", platform: "connector", via: "connector",
    access: { read: true, agents: true, commands: true }, confirm: "never", vouchedBy: gone,
  });
  assert.equal(client.vouchedBy, gone, "an AI client keeps the mark of the device that approved it");
  registry.registerPassKey(tablet, account, [gone]);

  assert.deepEqual(registry.resetPairing().dropped, [tablet, marked.publicKey, client.publicKey]);
  for (const publicKey of [tablet, marked.publicKey, client.publicKey]) {
    assert.equal(registry.get(publicKey), undefined);
    assert.equal(registry.isRevoked(publicKey), false, "deleted, not removed: it may pair again with the new code");
  }
  assert.equal(registry.get(plain.publicKey)?.kind, "computer");
  assert.equal(registry.get(phone)?.vouchedBy, undefined);
  assert.equal(registry.get(phone)?.passKey, undefined);
  assert.deepEqual(registry.trustedPassKeys(), [], "nothing is trusted until a device connects and says so");

  // The computer is unlocked, so the tablet comes back by the new code and
  // is recorded like any key that pairs by code. Its word now counts.
  registry.enroll({ publicKey: tablet, kind: "device", name: "Tab", platform: "android", via: "token", transport: 2 });
  assert.equal(registry.registerPassKey(tablet, account, [gone]).accepted, true);
  assert.deepEqual(new DeviceRegistry(state).trustedPassKeys(), [{ passKey: account, devices: [tablet] }]);
  assert.equal(registry.registerPassKey(tablet, gone, []).refusal, "retired", "what was retired stays retired");
});

test("a retired key this computer trusted is kept however many unseen keys follow", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const phone = recordedDevice(registry);
  const [trusted, unseen] = [newKey(), newKey()];
  registry.registerPassKey(phone, trusted, []);
  registry.registerPassKey(phone, newKey(), [trusted, unseen]);

  const flood = Array.from({ length: MAX_RETIRED_PASS_KEYS }, newKey);
  registry.registerPassKey(phone, newKey(), flood);
  assert.equal(unknownArray(parseJsonObject(fs.readFileSync(state, "utf8")).retiredPassKeys).length, MAX_RETIRED_PASS_KEYS, "only never-trusted keys are capped");
  assert.equal(registry.registerPassKey(phone, trusted, []).accepted, false);
  assert.equal(new DeviceRegistry(state).registerPassKey(phone, trusted, []).accepted, false);
  // A key nobody here ever trusted can fall off the capped list.
  assert.equal(registry.registerPassKey(phone, unseen, []).accepted, true);
});

test("the real retired key is applied when it comes after any number of made-up ones", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [first, second] = [newKey(), newKey()];
  const phone = recordedDevice(registry);
  registry.registerPassKey(phone, first, []);
  const laptop = recordedDevice(registry, { vouchedBy: first });

  // The vault appends the newest retired key last. A device that expects to
  // be removed can write any number of made-up keys in front of it, and some
  // entries that are no keys at all.
  const junk = Array.from({ length: MAX_RETIRED_PASS_KEYS + 44 }, newKey);
  const retired = retiredPassKeysOf([...junk, "not a key", 7, first]);
  assert.equal(retired.length, junk.length + 1);
  assert.equal(retired.at(-1), first);

  assert.deepEqual(registry.registerPassKey(phone, second, retired), { accepted: true, dropped: [laptop] });
  assert.equal(registry.trustsPassKey(first), false);
  assert.equal(registry.registerPassKey(phone, first, []).refusal, "retired");
  /** The retired keys this computer never trusted, as saved. */
  const unseen = () => unknownArray(parseJsonObject(fs.readFileSync(state, "utf8")).retiredPassKeys);
  assert.deepEqual(unseen(), junk.slice(-MAX_RETIRED_PASS_KEYS), "of the keys never trusted here, the newest are kept");

  // Every device repeats the list on every connection. That writes nothing.
  let writes = 0;
  registry.onChange(() => writes++);
  registry.registerPassKey(phone, second, retired);
  assert.equal(writes, 0);
});

test("no new pass key is taken once the record of them is full", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const phone = recordedDevice(registry);
  const taken = Array.from({ length: MAX_KNOWN_PASS_KEYS }, newKey);
  for (const key of taken) assert.equal(registry.registerPassKey(phone, key, []).accepted, true);

  const extra = newKey();
  assert.deepEqual(registry.registerPassKey(phone, extra, [taken[0]]), { accepted: false, refusal: "full", dropped: [] });
  assert.equal(registry.trustsPassKey(extra), false);
  assert.equal(registry.get(phone)?.passKey, taken.at(-1), "the device goes on carrying the key it had");
  assert.equal(unknownArray(parseJsonObject(fs.readFileSync(state, "utf8")).passKeys).length, MAX_KNOWN_PASS_KEYS);
  // A full record still hears retirements and still takes a key it knows.
  assert.equal(registry.registerPassKey(phone, taken[0], []).refusal, "retired");
  assert.equal(registry.registerPassKey(phone, taken[1], []).accepted, true);
});
