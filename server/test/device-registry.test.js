const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { DeviceRegistry, MAX_PREVIOUS_SECRETS, PREVIOUS_SECRET_LIFETIME_MS } = require("#server/device-registry");
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
    version: 1, mode: "enforced", revoked: [removed],
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

test("reset keeps the lists, clears previous secrets and unlocks", () => {
  const { state } = paths();
  const registry = new DeviceRegistry(state);
  const [phone, removed] = [newKey(), newKey()];
  registry.enroll({ publicKey: phone, kind: "device", name: "Pixel", platform: "android", via: "token", transport: 2 });
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
  assert.equal(registry.isRevoked(removed), true);
  assert.equal(toBase64(registry.relayOwnerKey().publicKey), ownerKey);
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
