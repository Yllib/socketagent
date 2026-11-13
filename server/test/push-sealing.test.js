const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const nacl = require("tweetnacl");

const { buildRelayPush, directPushData } = require("#server/push-notifications");
const { MAX_SEALED_PUSH_BYTES, pushDataMap, pushSealingSecrets, sealPush } = require("#server/push-sealing");
const { derivePushKey, secretTag } = require("#server/transport-v2");
const { parseJsonObject } = require("#server/value-guards");

// Sealed pushes, wire spec section 11: what the computer seals, for which
// secrets, and what each phone is sent.

const payload = {
  title: "Finished",
  body: "The build passed",
  sessionId: "session-1",
  status: "completed",
  kind: "session_finished",
  showNotification: false,
  data: { scheduledTaskId: "task-1", attempt: 2 },
};

/** Opens a sealed push the way a phone holding [secret] does. Null when no entry is for that secret. */
function open(/** @type {string} */ sealed, /** @type {Uint8Array} */ secret) {
  const entry = sealed.split(",").find((candidate) => candidate.startsWith(`${secretTag(secret)}.`));
  if (!entry) return null;
  const bytes = Buffer.from(entry.slice(9), "base64");
  const plaintext = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), derivePushKey(secret));
  return plaintext ? parseJsonObject(Buffer.from(plaintext).toString("utf8")) : null;
}

test("a sealed push opens under each secret it was sealed for and no other", () => {
  const secrets = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)];
  const sealed = sealPush(payload, secrets);
  assert.ok(sealed);
  assert.equal(sealed.split(",").length, 3);
  assert.deepEqual(sealed.split(",").map((entry) => entry.slice(0, 8)), secrets.map(secretTag), "newest first, as given");
  const expected = {
    scheduledTaskId: "task-1", attempt: "2",
    title: "Finished", body: "The build passed", sessionId: "session-1",
    status: "completed", kind: "session_finished", showNotification: "false",
  };
  for (const secret of secrets) assert.deepEqual(open(sealed, secret), expected);
  assert.equal(open(sealed, crypto.randomBytes(32)), null);
  assert.equal("serverId" in pushDataMap(payload), false, "the phone adds its own server ID");
  assert.equal(sealed.includes("Finished"), false);

  assert.equal(sealPush(payload, []), null, "no secret, nothing sealed");
});

test("a long body is cut until the sealed push fits 3,000 bytes", () => {
  const secrets = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)];
  // Letters of one, two and four bytes, so a cut can land beside a pair.
  const body = "aé😀".repeat(1000);
  const sealed = sealPush({ ...payload, body }, secrets);
  assert.ok(sealed);
  assert.ok(Buffer.byteLength(sealed) <= MAX_SEALED_PUSH_BYTES);
  for (const secret of secrets) {
    const opened = open(sealed, secret);
    assert.ok(opened);
    const cut = String(opened.body);
    assert.ok(cut.endsWith("..."));
    assert.ok(body.startsWith(cut.slice(0, -3)), "the body is cut, not changed");
    assert.equal(cut.includes("�"), false, "no letter is cut in half");
    assert.equal(opened.title, "Finished");
  }

  // One secret leaves room for a longer body than three do.
  const single = sealPush({ ...payload, body }, [secrets[0]]);
  assert.ok(single && Buffer.byteLength(single) <= MAX_SEALED_PUSH_BYTES);
  assert.ok(String(open(single, secrets[0])?.body).length > String(open(sealed, secrets[0])?.body).length);

  // A push that is too long with no body at all is not sent sealed.
  assert.equal(sealPush({ ...payload, title: "t".repeat(4000) }, secrets), null);
});

test("a push is sealed for the current secret and up to two older ones a recorded device still holds", () => {
  const secrets = [5, 4, 3, 2, 1].map((id) => ({ id, secret: crypto.randomBytes(32).toString("base64"), createdAt: "2026-11-01T00:00:00.000Z" }));
  /** @param {(number | undefined)[]} heldIds The newest secret each recorded phone was handed. */
  const source = (heldIds, readable = true) => ({
    readable,
    currentSecret: () => secrets[0],
    previousSecrets: () => secrets.slice(1),
    list: () => heldIds.map((secretId, index) => ({
      publicKey: `key-${index}`, kind: /** @type {const} */ ("device"), name: "Phone", platform: /** @type {const} */ ("android"),
      addedAt: "", lastSeenAt: "", via: /** @type {const} */ ("token"), transport: /** @type {const} */ (2), ...(secretId ? { secretId } : {}),
    })),
  });
  const ids = (/** @type {ReturnType<typeof source>} */ from) => pushSealingSecrets(from).map((secret) => secrets.find((candidate) => candidate.secret === secret.toString("base64"))?.id);

  assert.deepEqual(ids(source([5, 5])), [5], "no phone holds an older secret");
  assert.deepEqual(ids(source([5, 3, undefined])), [5, 3]);
  assert.deepEqual(ids(source([4, 2, 1, 2])), [5, 4, 2], "two older ones at most, newest first");
  assert.deepEqual(ids(source([5], false)), [], "an unreadable state file seals nothing");
});

test("legacy rides in relay_push only while plaintext is allowed and a registration needs it", () => {
  const entries = [
    { token: "a", platform: "android", appServerId: "old-id", updatedAt: "" },
    { token: "b", platform: "android", appServerId: "new-id", updatedAt: "" },
    { token: "c", platform: "android", updatedAt: "" },
  ];
  assert.deepEqual(buildRelayPush(payload, "sealed-text", entries, false), { sealed: "sealed-text", serverId: "new-id" });

  const oldPhone = { token: "old", platform: "android", updatedAt: "" };
  const v2Phone = { token: "new", platform: "android", v2: true, updatedAt: "" };
  assert.deepEqual(buildRelayPush(payload, "sealed-text", [v2Phone, oldPhone], true), {
    sealed: "sealed-text",
    legacy: {
      title: "Finished", body: "The build passed", sessionId: "session-1", status: "completed",
      kind: "session_finished", showNotification: false, data: { scheduledTaskId: "task-1", attempt: 2 },
    },
  });
  // A device record left on the old path is not enough. Some phone has to be registered for plaintext.
  assert.deepEqual(buildRelayPush(payload, "sealed-text", [v2Phone], true), { sealed: "sealed-text" });
  assert.deepEqual(buildRelayPush(payload, "sealed-text", [], true), { sealed: "sealed-text" });
});

test("the computer's own Firebase path sends the sealed shape to a phone that registered on v2", () => {
  const v2Phone = { token: "a", platform: "android", appServerId: "phone-a-id", v2: true, updatedAt: "" };
  const oldPhone = { token: "b", platform: "android", appServerId: "phone-b-id", updatedAt: "" };

  assert.deepEqual(directPushData(v2Phone, payload, "sealed-text", true), { v: "2", serverId: "phone-a-id", sealed: "sealed-text" });
  assert.equal(directPushData(v2Phone, payload, null, true), null, "never plaintext for a v2 phone");

  assert.deepEqual(directPushData(oldPhone, payload, "sealed-text", true), {
    title: "Finished", body: "The build passed", sessionId: "session-1", serverId: "phone-b-id",
    status: "completed", kind: "session_finished", scheduledTaskId: "task-1", attempt: "2",
  });
  assert.equal(directPushData(oldPhone, payload, "sealed-text", false), null, "no plaintext once no device is on the old path");
});
