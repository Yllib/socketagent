const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const { initiateHandshake, keyPairFromSecretKey, readMessage1 } = require("#server/noise-ikpsk1");
const {
  approvalCode,
  buildPrologue,
  derivePsk,
  derivePushKey,
  encodeHs1Frame,
  encodeHs2Frame,
  LOCAL_PSK,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_NOISE_MESSAGE_1_BYTES,
  parseHandshakePayload,
  parseHs1Frame,
  parseHs2Frame,
  RecordError,
  secretTag,
  TransportChannel,
  TRANSPORT_READY_MESSAGE,
} = require("#server/transport-v2");
const { isRecord, parseJsonObject, unknownArray } = require("#server/value-guards");
const { buildVectorFile, REPLY_MESSAGE, VECTOR_FILE } = require("../scripts/generate-transport-vectors");

/** The sample secret of spec section 2: the bytes 00 01 02 ... 1f. */
const SAMPLE_SECRET = Buffer.alloc(32).map((_, index) => index);

/** A pair of channels as a finished handshake would hand them out. */
function channelPair() {
  const initiatorKey = Buffer.alloc(32, 7);
  const responderKey = Buffer.alloc(32, 9);
  return {
    initiator: new TransportChannel({ role: "initiator", sendKey: initiatorKey, receiveKey: responderKey }),
    responder: new TransportChannel({ role: "responder", sendKey: responderKey, receiveKey: initiatorKey }),
  };
}

/** @param {unknown} value @param {string} name */
function text(value, name) {
  if (typeof value !== "string") throw new Error(`The fixture case has no ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// Check values printed in the wire spec
// ---------------------------------------------------------------------------

test("the derivations match the check values in spec section 2", () => {
  assert.equal(SAMPLE_SECRET.toString("base64"), "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
  assert.equal(derivePsk(SAMPLE_SECRET).toString("hex"), "ce3d02650c40c4a27ac683bc7c4a84119b290d27f2b876f680eaf71b555be40e");
  assert.equal(secretTag(SAMPLE_SECRET), "c9ce2a50");
  assert.equal(derivePushKey(SAMPLE_SECRET).toString("hex"), "61249b2da4822625b2c768625b627c859f28bea0dcda37fba4dcc84f9efd07cf");
  assert.equal(LOCAL_PSK.toString("hex"), "beba21a33f29547133cc5fc442ee2d7ca0b200a7b595b2e9a524d21f3866ca1d");
});

test("the prologue matches the check value in spec section 3.2", () => {
  const prologue = buildPrologue("relay", "control", "3f6c1e0a-9b7d-4c21-8e55-0a1b2c3d4e5f");
  assert.equal(prologue.length, 75);
  assert.equal(
    prologue.toString("hex"),
    "736f636b65746167656e742d7472616e73706f72742d76320072656c617900636f6e74726f"
      + "6c0033663663316530612d396237642d346332312d386535352d306131623263336434653566",
  );
});

test("a path and lane that cannot go together have no prologue", () => {
  assert.throws(() => buildPrologue("direct", "link", "room"));
  assert.throws(() => buildPrologue("local-request", "bulk", ""));
  assert.throws(() => buildPrologue("local-request", "control", "room"));
});

test("the approval code matches the check value in spec section 3.6", () => {
  const handshakeHash = Buffer.alloc(32).map((_, index) => 0xa0 + index);
  assert.equal(approvalCode(handshakeHash), "346869");
});

test("the initiator's first nonce matches the check value in spec section 4.1", () => {
  const { initiator } = channelPair();
  const frame = initiator.sealBinary(Buffer.from("x"));
  assert.equal(frame.subarray(0, 24).toString("hex"), "010000000000000000000000000000000000000000000001");
});

// ---------------------------------------------------------------------------
// The file shared with the app
// ---------------------------------------------------------------------------

test("the shared fixture is what the generator writes", () => {
  assert.equal(fs.readFileSync(VECTOR_FILE, "utf8"), buildVectorFile());
});

test("each fixture case runs again from its inputs alone", () => {
  const cases = unknownArray(parseJsonObject(fs.readFileSync(VECTOR_FILE, "utf8")).cases).filter(isRecord);
  assert.deepEqual(
    cases.map((entry) => `${text(entry.path, "path")} ${text(entry.lane, "lane")}`),
    ["relay control", "direct bulk", "local-request control", "relay link", "relay transfer"],
  );
  for (const entry of cases) {
    const expected = isRecord(entry.expect) ? entry.expect : {};
    const responderStatic = keyPairFromSecretKey(Buffer.from(text(entry.responderStaticSecret, "responderStaticSecret"), "hex"));
    const prologue = Buffer.from(text(expected.prologue, "prologue"), "hex");
    const psk = Buffer.from(text(expected.psk, "psk"), "hex");
    const initiator = initiateHandshake({
      prologue,
      staticKeyPair: keyPairFromSecretKey(Buffer.from(text(entry.initiatorStaticSecret, "initiatorStaticSecret"), "hex")),
      responderStaticKey: responderStatic.publicKey,
      psk,
      payload: Buffer.from(text(entry.payload1, "payload1"), "utf8"),
      fixedEphemeralKeyPair: keyPairFromSecretKey(Buffer.from(text(entry.initiatorEphemeralSecret, "initiatorEphemeralSecret"), "hex")),
    });
    if (entry.frameEncoding !== "text") continue;

    // The responder reads the frame as it is in the file, and both records open.
    const hs1 = parseHs1Frame(text(expected.hs1, "hs1"));
    assert.ok(hs1, `${entry.name}: hs1 parses`);
    assert.deepEqual(hs1.message, Buffer.from(initiator.message1));
    assert.equal(hs1.tag, expected.tag);
    const accepted = readMessage1({ prologue, staticKeyPair: responderStatic, message: hs1.message }).tryPsk(psk);
    assert.ok(accepted, `${entry.name}: message 1 verifies`);
    const hs2 = parseHs2Frame(text(expected.hs2, "hs2"));
    assert.ok(hs2, `${entry.name}: hs2 parses`);
    const finished = initiator.readMessage2(hs2);
    assert.equal(Buffer.from(finished.sendKey).toString("hex"), expected.initiatorSendKey);
    assert.equal(Buffer.from(finished.receiveKey).toString("hex"), expected.responderSendKey);
    assert.equal(approvalCode(finished.handshakeHash), expected.approvalCode);
    const responder = new TransportChannel({ role: "responder", sendKey: finished.receiveKey, receiveKey: finished.sendKey });
    const device = new TransportChannel({ role: "initiator", sendKey: finished.sendKey, receiveKey: finished.receiveKey });
    assert.equal(responder.openText(parseSealed(text(expected.firstRecord, "firstRecord"))), TRANSPORT_READY_MESSAGE);
    assert.equal(device.openText(parseSealed(text(expected.responderFirstRecord, "responderFirstRecord"))), REPLY_MESSAGE);
  }
});

/** @param {string} frame */
function parseSealed(frame) {
  const parsed = parseJsonObject(frame);
  return { n: text(parsed.n, "n"), c: text(parsed.c, "c") };
}

// ---------------------------------------------------------------------------
// Handshake frames
// ---------------------------------------------------------------------------

test("an hs1 frame is read only when it is one this side speaks", () => {
  const message = Buffer.alloc(96, 1);
  const frame = encodeHs1Frame({ path: "relay", lane: "control", tag: "c9ce2a50", message });
  assert.deepEqual(parseHs1Frame(frame), { path: "relay", lane: "control", tag: "c9ce2a50", message });

  const fields = parseJsonObject(frame);
  /** @param {Record<string, unknown>} change */
  const changed = (change) => parseHs1Frame(JSON.stringify({ ...fields, ...change }));
  assert.equal(changed({ v: 3 }), null, "another version");
  assert.equal(changed({ path: "bluetooth" }), null, "unknown path");
  assert.equal(changed({ path: "direct", lane: "link" }), null, "a lane that path does not carry");
  assert.equal(changed({ k: "C9CE2A50" }), null, "tag not lowercase hex");
  assert.equal(changed({ d: Buffer.alloc(95).toString("base64") }), null, "shorter than message 1");
  assert.equal(changed({ d: Buffer.alloc(MAX_NOISE_MESSAGE_1_BYTES + 1).toString("base64") }), null, "longer than message 1 may be");
  assert.equal(changed({ d: `${message.toString("base64")}\n` }), null, "not plain base64");
  assert.equal(parseHs1Frame("not json"), null);
  assert.equal(parseHs1Frame(JSON.stringify({ ...fields, padding: "x".repeat(MAX_HANDSHAKE_FRAME_BYTES) })), null, "oversized frame");
});

test("an hs2 frame is read only when it is one this side speaks", () => {
  const message = Buffer.alloc(48, 2);
  assert.deepEqual(parseHs2Frame(encodeHs2Frame(message)), message);
  assert.equal(parseHs2Frame(JSON.stringify({ type: "hs2", v: 3, d: message.toString("base64") })), null);
  assert.equal(parseHs2Frame(encodeHs2Frame(Buffer.alloc(47))), null);
});

test("a handshake payload must be a JSON object within the size limit", () => {
  assert.deepEqual(parseHandshakePayload(Buffer.from('{"app":"1.2.0"}')), { app: "1.2.0" });
  assert.equal(parseHandshakePayload(Buffer.from('["app"]')), null);
  assert.equal(parseHandshakePayload(Buffer.from("{")), null);
  assert.equal(parseHandshakePayload(Buffer.from(JSON.stringify({ name: "x".repeat(2048) }))), null);
});

// ---------------------------------------------------------------------------
// Record layer
// ---------------------------------------------------------------------------

test("records open in order, in both directions, as text and binary", () => {
  const { initiator, responder } = channelPair();
  assert.equal(responder.openText(initiator.sealText("one")), "one");
  assert.deepEqual(Buffer.from(responder.openBinary(initiator.sealBinary(Buffer.from("two")))), Buffer.from("two"));
  assert.equal(initiator.openText(responder.sealText("three")), "three");
});

test("a counter that does not increase closes the channel", () => {
  const { initiator, responder } = channelPair();
  const first = initiator.sealText("one");
  const second = initiator.sealText("two");
  assert.equal(responder.openText(second), "two");
  assert.throws(() => responder.openText(first), RecordError, "an older frame");
  assert.equal(responder.closed, true);
  assert.throws(() => responder.openText(initiator.sealText("three")), RecordError, "nothing opens after a refusal");
  assert.throws(() => responder.sealText("reply"), RecordError, "and nothing is sealed");
});

test("the same frame does not open twice", () => {
  const { initiator, responder } = channelPair();
  const frame = initiator.sealBinary(Buffer.from("once"));
  responder.openBinary(frame);
  assert.throws(() => responder.openBinary(frame), RecordError);
});

test("a frame sealed for the other direction is refused", () => {
  const key = Buffer.alloc(32, 5);
  // Both directions under one key, so only the direction byte tells them apart.
  const initiator = new TransportChannel({ role: "initiator", sendKey: key, receiveKey: key });
  assert.throws(() => initiator.openText(initiator.sealText("reflected")), RecordError);
});

test("a nonce with padding set, a changed box and a short frame are refused", () => {
  for (const damage of [
    /** @param {Buffer} frame */ (frame) => { frame[5] = 1; },
    /** @param {Buffer} frame */ (frame) => { frame[frame.length - 1] ^= 1; },
  ]) {
    const { initiator, responder } = channelPair();
    const frame = initiator.sealBinary(Buffer.from("payload"));
    damage(frame);
    assert.throws(() => responder.openBinary(frame), RecordError);
    assert.equal(responder.closed, true);
  }
  const { responder } = channelPair();
  assert.throws(() => responder.openBinary(Buffer.alloc(10)), RecordError);
});

test("a record sealed under another handshake's keys does not open", () => {
  const { responder } = channelPair();
  const stranger = new TransportChannel({ role: "initiator", sendKey: Buffer.alloc(32, 1), receiveKey: Buffer.alloc(32, 2) });
  assert.throws(() => responder.openText(stranger.sealText(TRANSPORT_READY_MESSAGE)), RecordError);
});
