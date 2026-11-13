#!/usr/bin/env node
// Writes test/fixtures/noise-ikpsk1-vectors.json: complete
// Noise_IKpsk1_25519_ChaChaPoly_SHA256 handshakes with every input fixed. The
// Dart handshake in the app must reproduce this file byte for byte, and
// test/noise-ikpsk1.test.js fails when the file and this script disagree.
//
//   npm run build && node scripts/generate-noise-vectors.js           write the file
//   npm run build && node scripts/generate-noise-vectors.js --check   exit 1 when the file is stale
//
// File layout
//
//   {
//     "protocol": "Noise_IKpsk1_25519_ChaChaPoly_SHA256",
//     "vectors": [ { ...one handshake, fields below... }, ... ]
//   }
//
// Every field of a vector is a string. `name` is plain ASCII. Every other
// field is lowercase hex with no prefix or separators, and an empty byte
// string is "". Fields appear in exactly this order.
//
//   Inputs:
//     name                         label for the vector
//     prologue                     any length
//     psk                          32 bytes
//     initiator_static_secret      32 bytes, raw X25519 private key
//     initiator_ephemeral_secret   32 bytes, raw X25519 private key
//     responder_static_secret      32 bytes, raw X25519 private key
//     responder_ephemeral_secret   32 bytes, raw X25519 private key
//     payload_1                    plaintext sealed into message 1
//     payload_2                    plaintext sealed into message 2
//   Outputs:
//     initiator_static_public      32 bytes
//     initiator_ephemeral_public   32 bytes
//     responder_static_public      32 bytes
//     responder_ephemeral_public   32 bytes
//     message_1                    initiator to responder, 96 bytes + payload_1
//     message_2                    responder to initiator, 48 bytes + payload_2
//     initiator_to_responder_key   32 bytes, first output of Split()
//     responder_to_initiator_key   32 bytes, second output of Split()
//     handshake_hash               32 bytes, h after message 2
//
// Private keys are used as X25519 defines: the function clamps them, and
// they are stored here unclamped. A public key is X25519(secret, 9).
//
// The file is UTF-8 with no byte order mark: the object above printed with
// two-space indentation, ": " after each key, one array element or field per
// line, "\n" line ends and one "\n" after the closing brace. That is
// JSON.stringify(file, null, 2) + "\n" in JavaScript and
// JsonEncoder.withIndent("  ").convert(file) + "\n" in Dart.
//
// To reproduce the file in another language, read the inputs of each vector
// from it, run the handshake as both sides with the two ephemeral keys fixed,
// rebuild the object from the inputs and your own outputs, print it as above
// and compare the bytes with the file.
//
// Where the inputs come from: prologue and payloads are set per vector in
// VECTORS below. The psk and the four secrets are
// SHA-256("noise-ikpsk1-vectors/<name>/<field>") over the ASCII bytes, so no
// key material is pasted into this script and none of it is a real secret.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { initiateHandshake, keyPairFromSecretKey, NOISE_PROTOCOL_NAME, readMessage1 } = require("#server/noise-ikpsk1");

const VECTOR_FILE = path.join(__dirname, "..", "test", "fixtures", "noise-ikpsk1-vectors.json");

/** `length` bytes that count up from `start`, wrapping at 251 so the run does not line up with any block size. @param {number} length @param {number} start */
function countingBytes(length, start) {
  return Buffer.alloc(length).map((_, index) => (start + index) % 251);
}

/** Every byte value once, ascending. */
const allByteValues = Buffer.alloc(256).map((_, index) => index);

const VECTORS = [
  { name: "empty", prologue: Buffer.alloc(0), payload1: Buffer.alloc(0), payload2: Buffer.alloc(0) },
  {
    name: "text",
    prologue: Buffer.from("noise-ikpsk1 vector prologue", "ascii"),
    payload1: Buffer.from("payload in message 1", "ascii"),
    payload2: Buffer.from("payload in message 2", "ascii"),
  },
  { name: "binary", prologue: allByteValues, payload1: Buffer.from(allByteValues).reverse(), payload2: allByteValues },
  { name: "long", prologue: countingBytes(300, 0), payload1: countingBytes(1000, 1), payload2: countingBytes(700, 2) },
];

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

/** @param {string} vectorName @param {string} field */
function derivedInput(vectorName, field) {
  return crypto.createHash("sha256").update(`noise-ikpsk1-vectors/${vectorName}/${field}`, "ascii").digest();
}

/** Runs one handshake as both sides and returns its vector. @param {typeof VECTORS[number]} vector */
function buildVector({ name, prologue, payload1, payload2 }) {
  const psk = derivedInput(name, "psk");
  const initiatorStatic = keyPairFromSecretKey(derivedInput(name, "initiator_static_secret"));
  const initiatorEphemeral = keyPairFromSecretKey(derivedInput(name, "initiator_ephemeral_secret"));
  const responderStatic = keyPairFromSecretKey(derivedInput(name, "responder_static_secret"));
  const responderEphemeral = keyPairFromSecretKey(derivedInput(name, "responder_ephemeral_secret"));

  const initiator = initiateHandshake({
    prologue,
    staticKeyPair: initiatorStatic,
    responderStaticKey: responderStatic.publicKey,
    psk,
    payload: payload1,
    fixedEphemeralKeyPair: initiatorEphemeral,
  });
  const accepted = readMessage1({ prologue, staticKeyPair: responderStatic, message: initiator.message1 }).tryPsk(psk);
  if (!accepted) throw new Error(`Vector ${name}: the responder refused message 1`);
  const responder = accepted.writeMessage2(payload2, responderEphemeral);
  const finished = initiator.readMessage2(responder.message2);

  // A vector is only written when both sides agree on everything in it.
  const agreed = hex(accepted.initiatorStaticKey) === hex(initiatorStatic.publicKey)
    && hex(accepted.payload) === hex(payload1)
    && hex(finished.payload) === hex(payload2)
    && hex(finished.sendKey) === hex(responder.receiveKey)
    && hex(finished.receiveKey) === hex(responder.sendKey)
    && hex(finished.handshakeHash) === hex(responder.handshakeHash);
  if (!agreed) throw new Error(`Vector ${name}: the two sides disagree`);

  return {
    name,
    prologue: hex(prologue),
    psk: hex(psk),
    initiator_static_secret: hex(initiatorStatic.secretKey),
    initiator_ephemeral_secret: hex(initiatorEphemeral.secretKey),
    responder_static_secret: hex(responderStatic.secretKey),
    responder_ephemeral_secret: hex(responderEphemeral.secretKey),
    payload_1: hex(payload1),
    payload_2: hex(payload2),
    initiator_static_public: hex(initiatorStatic.publicKey),
    initiator_ephemeral_public: hex(initiatorEphemeral.publicKey),
    responder_static_public: hex(responderStatic.publicKey),
    responder_ephemeral_public: hex(responderEphemeral.publicKey),
    message_1: hex(initiator.message1),
    message_2: hex(responder.message2),
    initiator_to_responder_key: hex(finished.sendKey),
    responder_to_initiator_key: hex(finished.receiveKey),
    handshake_hash: hex(finished.handshakeHash),
  };
}

/** The exact text of the vector file. */
function buildVectorFile() {
  return `${JSON.stringify({ protocol: NOISE_PROTOCOL_NAME, vectors: VECTORS.map(buildVector) }, null, 2)}\n`;
}

module.exports = { buildVectorFile, VECTOR_FILE };

if (require.main === module) {
  const text = buildVectorFile();
  if (process.argv[2] === "--check") {
    const current = fs.existsSync(VECTOR_FILE) ? fs.readFileSync(VECTOR_FILE, "utf8") : "";
    if (current !== text) {
      console.error(`${VECTOR_FILE} is stale. Run: node scripts/generate-noise-vectors.js`);
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(VECTOR_FILE, text);
    console.log(`Wrote ${VECTOR_FILE}`);
  }
}
