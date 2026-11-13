const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  generateKeyPair,
  initiateHandshake,
  keyPairFromSecretKey,
  NOISE_MAX_MESSAGE_LENGTH,
  NOISE_MESSAGE_1_OVERHEAD,
  NOISE_PROTOCOL_NAME,
  NoiseError,
  readMessage1,
} = require("#server/noise-ikpsk1");
const { dh, refuseZeroDh, SymmetricState } = require("#server/noise-symmetric");
const { isRecord, parseJsonObject, unknownArray } = require("#server/value-guards");
const { buildVectorFile, VECTOR_FILE } = require("../scripts/generate-noise-vectors");

/** @typedef {import("#server/noise-ikpsk1").NoiseKeyPair} NoiseKeyPair */
/** @typedef {import("#server/noise-ikpsk1").NoiseFailure} NoiseFailure */

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

/** Matches the NoiseError a refusal throws. @param {NoiseFailure} reason */
function refusal(reason) {
  /** @param {unknown} error */
  return (error) => error instanceof NoiseError && error.reason === reason;
}

// ---------------------------------------------------------------------------
// Published vectors
// ---------------------------------------------------------------------------

/**
 * One published handshake. The four keys are private keys. `messages` holds
 * the two handshake messages, then transport messages sent in turn starting
 * with the initiator.
 * @typedef {{
 *   prologue: Buffer, psk: Buffer,
 *   initiatorStatic: Buffer, initiatorEphemeral: Buffer, responderStatic: Buffer, responderEphemeral: Buffer,
 *   handshakeHash: Buffer | null,
 *   messages: { payload: Buffer, ciphertext: Buffer }[],
 * }} PublishedVector
 */

/** @param {unknown} value @param {string} name */
function hexValue(value, name) {
  if (typeof value !== "string") throw new Error(`Published vector has no ${name}`);
  return Buffer.from(value, "hex");
}

/** @param {unknown} section */
function sectionVectors(section) {
  return unknownArray(isRecord(section) ? section.vectors : undefined).filter(isRecord);
}

/** @returns {{ source: string, vector: PublishedVector }[]} */
function publishedVectors() {
  const file = parseJsonObject(fs.readFileSync(path.join(__dirname, "fixtures", "noise-ikpsk1-published-vectors.json"), "utf8"));
  const cacophony = sectionVectors(file.cacophony).map((entry, index) => {
    assert.equal(entry.protocol_name, NOISE_PROTOCOL_NAME);
    const responderStatic = hexValue(entry.resp_static, "resp_static");
    assert.equal(hex(hexValue(entry.init_remote_static, "init_remote_static")), hex(keyPairFromSecretKey(responderStatic).publicKey));
    assert.equal(entry.init_prologue, entry.resp_prologue);
    assert.deepEqual(entry.init_psks, entry.resp_psks);
    return {
      source: `cacophony ${index}`,
      vector: {
        prologue: hexValue(entry.init_prologue, "init_prologue"),
        psk: hexValue(unknownArray(entry.init_psks)[0], "init_psks[0]"),
        initiatorStatic: hexValue(entry.init_static, "init_static"),
        initiatorEphemeral: hexValue(entry.init_ephemeral, "init_ephemeral"),
        responderStatic,
        responderEphemeral: hexValue(entry.resp_ephemeral, "resp_ephemeral"),
        handshakeHash: hexValue(entry.handshake_hash, "handshake_hash"),
        messages: unknownArray(entry.messages).filter(isRecord).map((message) => ({
          payload: hexValue(message.payload, "payload"),
          ciphertext: hexValue(message.ciphertext, "ciphertext"),
        })),
      },
    };
  });
  const flynn = sectionVectors(file.flynn).map((entry, index) => {
    assert.equal(entry.handshake, NOISE_PROTOCOL_NAME);
    return {
      source: `flynn ${index}`,
      vector: {
        prologue: hexValue(entry.prologue ?? "", "prologue"),
        psk: hexValue(entry.preshared_key, "preshared_key"),
        initiatorStatic: hexValue(entry.init_static, "init_static"),
        initiatorEphemeral: hexValue(entry.gen_init_ephemeral, "gen_init_ephemeral"),
        responderStatic: hexValue(entry.resp_static, "resp_static"),
        responderEphemeral: hexValue(entry.gen_resp_ephemeral, "gen_resp_ephemeral"),
        handshakeHash: null,
        messages: [0, 1, 2, 3].map((number) => ({
          payload: hexValue(entry[`msg_${number}_payload`], `msg_${number}_payload`),
          ciphertext: hexValue(entry[`msg_${number}_ciphertext`], `msg_${number}_ciphertext`),
        })),
      },
    };
  });
  return [...cacophony, ...flynn];
}

/**
 * Opens a Noise transport message as section 5.1 of the spec defines it:
 * ChaChaPoly under a transport key, the counter as nonce, no associated data.
 * The handshake core does not do this, so the test does it to show that the
 * raw keys it returns are the keys the published transport messages used.
 * @param {Uint8Array} key @param {number} counter @param {Buffer} ciphertext
 */
function openTransportMessage(key, counter, ciphertext) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(counter, 4);
  const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
}

test("published vectors: both messages, the handshake hash and the transport keys match", () => {
  const published = publishedVectors();
  assert.equal(published.length, 5);
  for (const { source, vector } of published) {
    const [first, second, ...transport] = vector.messages;
    const initiatorStatic = keyPairFromSecretKey(vector.initiatorStatic);
    const responderStatic = keyPairFromSecretKey(vector.responderStatic);

    const initiator = initiateHandshake({
      prologue: vector.prologue,
      staticKeyPair: initiatorStatic,
      responderStaticKey: responderStatic.publicKey,
      psk: vector.psk,
      payload: first.payload,
      fixedEphemeralKeyPair: keyPairFromSecretKey(vector.initiatorEphemeral),
    });
    assert.equal(hex(initiator.message1), hex(first.ciphertext), `${source} message 1`);

    // The responder reads the published bytes, not the ones written above.
    const message1 = readMessage1({ prologue: vector.prologue, staticKeyPair: responderStatic, message: first.ciphertext });
    assert.equal(hex(message1.initiatorStaticKey), hex(initiatorStatic.publicKey), `${source} initiator key`);
    const accepted = message1.tryPsk(vector.psk);
    assert.ok(accepted, `${source} PSK`);
    assert.equal(hex(accepted.payload), hex(first.payload), `${source} payload 1`);
    const responder = accepted.writeMessage2(second.payload, keyPairFromSecretKey(vector.responderEphemeral));
    assert.equal(hex(responder.message2), hex(second.ciphertext), `${source} message 2`);

    const finished = initiator.readMessage2(second.ciphertext);
    assert.equal(hex(finished.payload), hex(second.payload), `${source} payload 2`);
    assert.equal(hex(finished.handshakeHash), hex(responder.handshakeHash), `${source} hash agreement`);
    if (vector.handshakeHash) assert.equal(hex(finished.handshakeHash), hex(vector.handshakeHash), `${source} handshake hash`);
    assert.equal(hex(finished.sendKey), hex(responder.receiveKey), `${source} initiator key agreement`);
    assert.equal(hex(finished.receiveKey), hex(responder.sendKey), `${source} responder key agreement`);

    assert.ok(transport.length >= 2, `${source} has transport messages`);
    transport.forEach((message, index) => {
      const key = index % 2 === 0 ? finished.sendKey : responder.sendKey;
      const opened = openTransportMessage(key, Math.floor(index / 2), message.ciphertext);
      assert.equal(hex(opened), hex(message.payload), `${source} transport message ${index}`);
    });
  }
});

test("the cross-language vector file is what its generator writes", () => {
  assert.equal(fs.readFileSync(VECTOR_FILE, "utf8"), buildVectorFile());
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Two parties that share a prologue and a PSK. */
function parties() {
  return {
    prologue: Buffer.from("refusal test prologue"),
    psk: crypto.randomBytes(32),
    initiatorStatic: generateKeyPair(),
    responderStatic: generateKeyPair(),
    payload: Buffer.from("hello"),
  };
}

/** The initiator's half for `parties()`, with any option replaced. @param {ReturnType<typeof parties>} p @param {Partial<Parameters<typeof initiateHandshake>[0]>} [overrides] */
function initiate(p, overrides = {}) {
  return initiateHandshake({
    prologue: p.prologue,
    staticKeyPair: p.initiatorStatic,
    responderStaticKey: p.responderStatic.publicKey,
    psk: p.psk,
    payload: p.payload,
    ...overrides,
  });
}

/** Reads message 1 as the responder of `parties()` and accepts it with the right PSK. @param {ReturnType<typeof parties>} p @param {Uint8Array} message */
function accept(p, message) {
  const accepted = readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message }).tryPsk(p.psk);
  assert.ok(accepted);
  return accepted;
}

/** Whether the responder of `parties()` takes `message` with the right PSK. Any refusal counts as no. @param {ReturnType<typeof parties>} p @param {Uint8Array} message */
function responderAccepts(p, message) {
  try {
    return readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message }).tryPsk(p.psk) !== null;
  } catch (error) {
    if (error instanceof NoiseError) return false;
    throw error;
  }
}

/**
 * Message 1 written token by token, for inputs the real initiator cannot
 * produce: `staticKey` goes out as the initiator's static key, and `ss` is
 * mixed in where the DH of that key belongs.
 * @param {{ prologue: Uint8Array, responderStaticKey: Uint8Array, staticKey: Uint8Array, ss: Uint8Array, psk: Uint8Array, payload: Uint8Array }} input
 */
function handBuiltMessage1({ prologue, responderStaticKey, staticKey, ss, psk, payload }) {
  const ephemeral = generateKeyPair();
  const state = SymmetricState.initialize(NOISE_PROTOCOL_NAME);
  state.mixHash(prologue);
  state.mixHash(responderStaticKey);
  state.mixHash(ephemeral.publicKey);
  state.mixKey(ephemeral.publicKey);
  state.mixKey(dh(ephemeral.secretKey, responderStaticKey));
  const sealedStaticKey = state.encryptAndHash(staticKey);
  state.mixKey(ss);
  state.mixKeyAndHash(psk);
  return Buffer.concat([ephemeral.publicKey, sealedStaticKey, state.encryptAndHash(payload)]);
}

/**
 * Message 2 written token by token by a party that holds the responder's
 * static key and mixes in `psk`, without checking message 1 against it.
 * @param {{ prologue: Uint8Array, responderStatic: NoiseKeyPair, message1: Uint8Array, psk: Uint8Array, payload: Uint8Array }} input
 */
function handBuiltMessage2({ prologue, responderStatic, message1, psk, payload }) {
  const initiatorEphemeralKey = message1.subarray(0, 32);
  const ephemeral = generateKeyPair();
  const state = SymmetricState.initialize(NOISE_PROTOCOL_NAME);
  state.mixHash(prologue);
  state.mixHash(responderStatic.publicKey);
  state.mixHash(initiatorEphemeralKey);
  state.mixKey(initiatorEphemeralKey);
  state.mixKey(dh(responderStatic.secretKey, initiatorEphemeralKey));
  const initiatorStaticKey = state.decryptAndHash(message1.subarray(32, 80));
  state.mixKey(dh(responderStatic.secretKey, initiatorStaticKey));
  state.mixKeyAndHash(psk);
  state.mixHash(message1.subarray(80));
  state.mixHash(ephemeral.publicKey);
  state.mixKey(ephemeral.publicKey);
  state.mixKey(dh(ephemeral.secretKey, initiatorEphemeralKey));
  state.mixKey(dh(ephemeral.secretKey, initiatorStaticKey));
  return Buffer.concat([ephemeral.publicKey, state.encryptAndHash(payload)]);
}

// Every X25519 public key whose DH result is all zero: the seven low-order
// points, and the same seven with the unused top bit set, which X25519 ignores.
const LOW_ORDER_KEYS = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].flatMap((point) => {
  const withTopBit = Buffer.from(point, "hex");
  withTopBit[31] |= 0x80;
  return [Buffer.from(point, "hex"), withTopBit];
});

test("a wrong PSK is refused, and the same message 1 can be tried against the next candidate", () => {
  const p = parties();
  const message1 = readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message: initiate(p).message1 });
  // Known before any PSK is tried, so the caller can pick candidates by peer.
  assert.equal(hex(message1.initiatorStaticKey), hex(p.initiatorStatic.publicKey));
  assert.equal(message1.tryPsk(crypto.randomBytes(32)), null);
  assert.equal(message1.tryPsk(Buffer.alloc(32)), null);
  const accepted = message1.tryPsk(p.psk);
  assert.ok(accepted);
  assert.equal(hex(accepted.payload), hex(p.payload));
  assert.throws(() => message1.tryPsk(Buffer.alloc(31)), refusal("malformed"));
});

test("message 2 verifies only when its sender mixed in the PSK", () => {
  const p = parties();
  const initiator = initiate(p);
  const build = { prologue: p.prologue, responderStatic: p.responderStatic, message1: initiator.message1, payload: Buffer.from("open") };
  assert.throws(() => initiator.readMessage2(handBuiltMessage2({ ...build, psk: crypto.randomBytes(32) })), refusal("decrypt"));
  // The same construction with the right PSK is accepted, so the PSK is what the refusal turned on.
  assert.equal(hex(initiator.readMessage2(handBuiltMessage2({ ...build, psk: p.psk })).payload), hex(build.payload));
});

test("a claimed static key is refused without its private half, even with the PSK", () => {
  const p = parties();
  const build = { prologue: p.prologue, responderStaticKey: p.responderStatic.publicKey, psk: p.psk, payload: p.payload };
  const forged = handBuiltMessage1({ ...build, staticKey: p.initiatorStatic.publicKey, ss: crypto.randomBytes(32) });
  const message1 = readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message: forged });
  assert.equal(hex(message1.initiatorStaticKey), hex(p.initiatorStatic.publicKey));
  assert.equal(message1.tryPsk(p.psk), null);
  // The same construction with the real DH result is accepted.
  const honest = handBuiltMessage1({ ...build, staticKey: p.initiatorStatic.publicKey, ss: dh(p.initiatorStatic.secretKey, p.responderStatic.publicKey) });
  assert.equal(hex(accept(p, honest).payload), hex(p.payload));
});

test("a message 1 for another prologue or another responder is refused", () => {
  const p = parties();
  const { message1 } = initiate(p);
  assert.throws(() => readMessage1({ prologue: Buffer.from("another lane"), staticKeyPair: p.responderStatic, message: message1 }), refusal("decrypt"));
  assert.throws(() => readMessage1({ prologue: p.prologue, staticKeyPair: generateKeyPair(), message: message1 }), refusal("decrypt"));
});

test("a message 2 for another prologue is refused", () => {
  const p = parties();
  const initiator = initiate(p, { prologue: Buffer.from("another lane") });
  const responder = accept({ ...p, prologue: Buffer.from("another lane") }, initiator.message1).writeMessage2(Buffer.alloc(0));
  assert.throws(() => initiate(p).readMessage2(responder.message2), refusal("decrypt"));
});

test("a flipped bit anywhere in either message is refused", () => {
  const p = parties();
  const initiator = initiate(p);
  for (let index = 0; index < initiator.message1.length; index++) {
    const tampered = Buffer.from(initiator.message1);
    tampered[index] ^= 1 << (index % 8);
    assert.equal(responderAccepts(p, tampered), false, `message 1 byte ${index}`);
  }

  const responder = accept(p, initiator.message1).writeMessage2(Buffer.from("open"));
  for (let index = 0; index < responder.message2.length; index++) {
    const tampered = Buffer.from(responder.message2);
    tampered[index] ^= 1 << (index % 8);
    assert.throws(() => initiator.readMessage2(tampered), NoiseError, `message 2 byte ${index}`);
  }
  // The forged answers above did not use up the handshake.
  assert.equal(hex(initiator.readMessage2(responder.message2).sendKey), hex(responder.receiveKey));
});

test("truncated and oversized messages are refused", () => {
  const p = parties();
  const initiator = initiate(p, { payload: Buffer.alloc(0) });
  assert.throws(() => readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message: initiator.message1.subarray(0, 95) }), refusal("malformed"));
  assert.throws(() => initiator.readMessage2(Buffer.alloc(47)), refusal("malformed"));
  const largest = Buffer.alloc(NOISE_MAX_MESSAGE_LENGTH - NOISE_MESSAGE_1_OVERHEAD, 7);
  assert.equal(hex(accept(p, initiate(p, { payload: largest }).message1).payload), hex(largest));
  assert.throws(() => initiate(p, { payload: Buffer.alloc(largest.length + 1) }), refusal("malformed"));
  assert.throws(() => readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message: Buffer.alloc(NOISE_MAX_MESSAGE_LENGTH + 1) }), refusal("malformed"));
});

test("a zero or low-order public key is refused in every position", () => {
  const p = parties();
  const initiator = initiate(p);
  const responder = accept(p, initiator.message1).writeMessage2(Buffer.alloc(0));
  assert.equal(LOW_ORDER_KEYS.length, 14);
  for (const lowOrder of LOW_ORDER_KEYS) {
    const name = hex(lowOrder);
    // The responder's static key, as the initiator knows it.
    assert.throws(() => initiate(p, { responderStaticKey: lowOrder }), refusal("dh"), `responder static ${name}`);
    // The initiator's ephemeral key in message 1.
    const lowEphemeral1 = Buffer.concat([lowOrder, initiator.message1.subarray(32)]);
    assert.throws(() => readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message: lowEphemeral1 }), refusal("dh"), `message 1 ephemeral ${name}`);
    // The initiator's static key in message 1. Its DH result is all zero for
    // anyone, so this message is otherwise valid and carries the right PSK.
    const lowStatic = handBuiltMessage1({
      prologue: p.prologue,
      responderStaticKey: p.responderStatic.publicKey,
      staticKey: lowOrder,
      ss: Buffer.alloc(32),
      psk: p.psk,
      payload: p.payload,
    });
    assert.throws(() => readMessage1({ prologue: p.prologue, staticKeyPair: p.responderStatic, message: lowStatic }), refusal("dh"), `message 1 static ${name}`);
    // The responder's ephemeral key in message 2.
    const lowEphemeral2 = Buffer.concat([lowOrder, responder.message2.subarray(32)]);
    assert.throws(() => initiator.readMessage2(lowEphemeral2), refusal("dh"), `message 2 ephemeral ${name}`);
  }
});

test("an all-zero DH result is refused whatever the library returned", () => {
  assert.throws(() => refuseZeroDh(Buffer.alloc(32)), refusal("dh"));
  const shared = crypto.randomBytes(32);
  assert.equal(refuseZeroDh(shared), shared);
});

test("a replayed message 1 gets keys that nothing recorded earlier fits", () => {
  const p = parties();
  const initiator = initiate(p);
  const first = accept(p, initiator.message1).writeMessage2(Buffer.from("open"));
  const replayed = accept(p, initiator.message1).writeMessage2(Buffer.from("open"));
  assert.notEqual(hex(replayed.message2), hex(first.message2));
  assert.notEqual(hex(replayed.sendKey), hex(first.sendKey));
  assert.notEqual(hex(replayed.receiveKey), hex(first.receiveKey));
  assert.notEqual(hex(replayed.handshakeHash), hex(first.handshakeHash));
  // The initiator's keys fit the answer it read and not the replay's.
  const finished = initiator.readMessage2(first.message2);
  assert.equal(hex(finished.sendKey), hex(first.receiveKey));
  assert.notEqual(hex(finished.sendKey), hex(replayed.receiveKey));
  // A recorded message 2 does not finish a later handshake between the same two parties.
  assert.throws(() => initiate(p).readMessage2(first.message2), refusal("decrypt"));
});

test("message 2 is written once per accepted message 1", () => {
  const p = parties();
  const accepted = accept(p, initiate(p).message1);
  accepted.writeMessage2(Buffer.alloc(0));
  assert.throws(() => accepted.writeMessage2(Buffer.alloc(0)), /already written/);
});
