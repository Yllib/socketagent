#!/usr/bin/env node
// Writes test/fixtures/transport-v2-vectors.json: whole transport v2
// handshakes with every input fixed, from the pairing secret to the first
// sealed record (wire spec section 15). The app copies the file byte for byte
// to test/fixtures/transport_v2_vectors.json and must reproduce every value
// in it. test/transport-v2.test.js fails when the file and this script
// disagree.
//
//   npm run build && node scripts/generate-transport-vectors.js           write the file
//   npm run build && node scripts/generate-transport-vectors.js --check   exit 1 when the file is stale
//
// File layout
//
//   { "cases": [ { ...one handshake, fields below, in this order... }, ... ] }
//
//   Inputs:
//     name                       label for the case
//     initiatorStaticSecret      hex, 32 bytes, raw X25519 private key
//     initiatorEphemeralSecret   hex, 32 bytes
//     responderStaticSecret      hex, 32 bytes
//     responderEphemeralSecret   hex, 32 bytes
//     secret                     hex, 32 bytes: the pairing, link or transfer secret
//     path                       "relay" | "direct" | "local-request"
//     lane                       "control" | "bulk" | "link" | "transfer"
//     context                    the prologue context, a plain string
//     payload1                   the exact JSON text sealed into message 1
//     payload2                   the exact JSON text sealed into message 2
//     frameEncoding              "text" or "hex", how hs1, hs2 and the two records are written below
//   expect:
//     prologue                   hex
//     psk                        hex, 32 bytes
//     tag                        8 hex characters, the `k` of hs1
//     hs1                        the frame the initiator sends
//     hs2                        the frame the responder sends
//     initiatorSendKey           hex, 32 bytes, first output of Split()
//     responderSendKey           hex, 32 bytes, second output of Split()
//     handshakeHash              hex, 32 bytes
//     approvalCode               six digits
//     firstRecord                the initiator's first record, the sealed transport_ready
//     responderFirstRecord       the responder's first record, sealing REPLY_MESSAGE below
//
// frameEncoding "text" is every case but the transfer one: hs1 and hs2 are
// the exact JSON text frames of spec section 3.3, and a record is the exact
// text frame {"n":"<base64 nonce>","c":"<base64 box>"} whose plaintext is the
// message's JSON text.
//
// frameEncoding "hex" is the session-transfer socket, which carries binary
// frames only: hs1 is 0x48 0x01 | tag | Noise message 1, hs2 is
// 0x48 0x02 | Noise message 2, and a record is nonce (24) | box whose
// plaintext is [4-byte big-endian header length][JSON header]. All four are
// written in hex.
//
// Two fields go past the list in the spec. frameEncoding says how to read
// the frames without knowing the lane. responderFirstRecord checks the other
// direction of the record layer, the key and direction byte the responder
// seals with, which firstRecord alone does not cover.
//
// The local-request case has no secret of its own. Its psk is the public
// constant localPsk, HKDF(32 zero bytes, "socketagent/v2/local-request"),
// its tag is the literal 00000000, and `secret` holds the 32 zero bytes the
// constant is derived from.
//
// Where the inputs come from: path, lane, context and payloads are set per
// case in CASES below. The secret and the four keys are
// SHA-256("transport-v2-vectors/<name>/<field>") over the ASCII bytes, so no
// key material is pasted into this script and none of it is a real secret.
//
// The file is UTF-8 with no byte order mark: JSON.stringify(file, null, 2)
// and one "\n" after the closing brace.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { initiateHandshake, keyPairFromSecretKey, readMessage1 } = require("#server/noise-ikpsk1");
const {
  approvalCode,
  buildPrologue,
  derivePsk,
  encodeBinaryHs1,
  encodeBinaryHs2,
  encodeHs1Frame,
  encodeHs2Frame,
  LOCAL_PSK,
  LOCAL_REQUEST_TAG,
  secretTag,
  TransportChannel,
  TRANSPORT_READY_MESSAGE,
} = require("#server/transport-v2");

const VECTOR_FILE = path.join(__dirname, "..", "test", "fixtures", "transport-v2-vectors.json");

/** What the responder seals as its first record in every case. Not a real message. */
const REPLY_MESSAGE = JSON.stringify({ type: "fixture_reply" });

const DEVICE_PAYLOAD = JSON.stringify({ app: "1.2.0", name: "Pixel 9", platform: "android", caps: { binaryEnvelope: true, uploadAckVersion: 1 } });
const COMPUTER_PAYLOAD = JSON.stringify({ app: "1.1.530" });
const OPEN = JSON.stringify({ status: "open", server: "1.1.530" });
const PENDING = JSON.stringify({ status: "pending", server: "1.1.530" });

/** @typedef {import("#server/transport-v2").TransportPath} TransportPath */
/** @typedef {import("#server/transport-v2").HandshakeLane} HandshakeLane */

/** @type {{ name: string, path: TransportPath, lane: HandshakeLane, context: string, payload1: string, payload2: string }[]} */
const CASES = [
  { name: "relay control open", path: "relay", lane: "control", context: "3f6c1e0a-9b7d-4c21-8e55-0a1b2c3d4e5f", payload1: DEVICE_PAYLOAD, payload2: OPEN },
  {
    name: "direct bulk open", path: "direct", lane: "bulk",
    context: "5d1e7a90c3b24f6688a1d0e2f4b6c8da13579bdf02468ace1f3e5d7c9b0a2c4e", payload1: DEVICE_PAYLOAD, payload2: OPEN,
  },
  { name: "local-request pending", path: "local-request", lane: "control", context: "", payload1: DEVICE_PAYLOAD, payload2: PENDING },
  {
    name: "relay link open", path: "relay", lane: "link",
    context: "a7c3e91f5b2d4068f1e3d5c7b9a0c2e4f60718293a4b5c6d7e8f90a1b2c3d4e5", payload1: COMPUTER_PAYLOAD, payload2: OPEN,
  },
  { name: "relay transfer open", path: "relay", lane: "transfer", context: "0b9d7f53-2c4e-4a68-9b1d-3f5a7c9e1b2d", payload1: COMPUTER_PAYLOAD, payload2: OPEN },
];

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

/** @param {string} caseName @param {string} field */
function derivedInput(caseName, field) {
  return crypto.createHash("sha256").update(`transport-v2-vectors/${caseName}/${field}`, "ascii").digest();
}

/** The plaintext of a record on the session-transfer socket. @param {string} header */
function transferRecord(header) {
  const json = Buffer.from(header, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json]);
}

/** Runs one handshake as both sides and returns its case. @param {typeof CASES[number]} input */
function buildCase({ name, path: transportPath, lane, context, payload1, payload2 }) {
  const local = transportPath === "local-request";
  const binary = lane === "transfer";
  const secret = local ? Buffer.alloc(32) : derivedInput(name, "secret");
  const psk = local ? LOCAL_PSK : derivePsk(secret);
  const tag = local ? LOCAL_REQUEST_TAG : secretTag(secret);
  const initiatorStatic = keyPairFromSecretKey(derivedInput(name, "initiatorStaticSecret"));
  const initiatorEphemeral = keyPairFromSecretKey(derivedInput(name, "initiatorEphemeralSecret"));
  const responderStatic = keyPairFromSecretKey(derivedInput(name, "responderStaticSecret"));
  const responderEphemeral = keyPairFromSecretKey(derivedInput(name, "responderEphemeralSecret"));
  const prologue = buildPrologue(transportPath, lane, context);

  const initiator = initiateHandshake({
    prologue,
    staticKeyPair: initiatorStatic,
    responderStaticKey: responderStatic.publicKey,
    psk,
    payload: Buffer.from(payload1, "utf8"),
    fixedEphemeralKeyPair: initiatorEphemeral,
  });
  const accepted = readMessage1({ prologue, staticKeyPair: responderStatic, message: initiator.message1 }).tryPsk(psk);
  if (!accepted) throw new Error(`Case ${name}: the responder refused message 1`);
  const responder = accepted.writeMessage2(Buffer.from(payload2, "utf8"), responderEphemeral);
  const finished = initiator.readMessage2(responder.message2);

  const initiatorChannel = new TransportChannel({ role: "initiator", sendKey: finished.sendKey, receiveKey: finished.receiveKey });
  const responderChannel = new TransportChannel({ role: "responder", sendKey: responder.sendKey, receiveKey: responder.receiveKey });
  // Each side seals its first record, and a case is only written when the
  // other side opens it.
  /** @type {string} */
  let firstRecord;
  /** @type {string} */
  let responderFirstRecord;
  /** @type {boolean} */
  let opened;
  if (binary) {
    const ready = initiatorChannel.sealBinary(transferRecord(TRANSPORT_READY_MESSAGE));
    const reply = responderChannel.sealBinary(transferRecord(REPLY_MESSAGE));
    firstRecord = hex(ready);
    responderFirstRecord = hex(reply);
    opened = Buffer.from(responderChannel.openBinary(ready)).equals(transferRecord(TRANSPORT_READY_MESSAGE))
      && Buffer.from(initiatorChannel.openBinary(reply)).equals(transferRecord(REPLY_MESSAGE));
  } else {
    const ready = initiatorChannel.sealText(TRANSPORT_READY_MESSAGE);
    const reply = responderChannel.sealText(REPLY_MESSAGE);
    firstRecord = JSON.stringify(ready);
    responderFirstRecord = JSON.stringify(reply);
    opened = responderChannel.openText(ready) === TRANSPORT_READY_MESSAGE && initiatorChannel.openText(reply) === REPLY_MESSAGE;
  }
  const agreed = opened
    && hex(accepted.initiatorStaticKey) === hex(initiatorStatic.publicKey)
    && hex(accepted.payload) === hex(Buffer.from(payload1, "utf8"))
    && hex(finished.payload) === hex(Buffer.from(payload2, "utf8"))
    && hex(finished.sendKey) === hex(responder.receiveKey)
    && hex(finished.receiveKey) === hex(responder.sendKey)
    && hex(finished.handshakeHash) === hex(responder.handshakeHash);
  if (!agreed) throw new Error(`Case ${name}: the two sides disagree`);

  return {
    name,
    initiatorStaticSecret: hex(initiatorStatic.secretKey),
    initiatorEphemeralSecret: hex(initiatorEphemeral.secretKey),
    responderStaticSecret: hex(responderStatic.secretKey),
    responderEphemeralSecret: hex(responderEphemeral.secretKey),
    secret: hex(secret),
    path: transportPath,
    lane,
    context,
    payload1,
    payload2,
    frameEncoding: binary ? "hex" : "text",
    expect: {
      prologue: hex(prologue),
      psk: hex(psk),
      tag,
      hs1: binary ? hex(encodeBinaryHs1(tag, initiator.message1)) : encodeHs1Frame({ path: transportPath, lane, tag, message: Buffer.from(initiator.message1) }),
      hs2: binary ? hex(encodeBinaryHs2(responder.message2)) : encodeHs2Frame(responder.message2),
      initiatorSendKey: hex(finished.sendKey),
      responderSendKey: hex(finished.receiveKey),
      handshakeHash: hex(finished.handshakeHash),
      approvalCode: approvalCode(finished.handshakeHash),
      firstRecord,
      responderFirstRecord,
    },
  };
}

/** The exact text of the vector file. */
function buildVectorFile() {
  return `${JSON.stringify({ cases: CASES.map(buildCase) }, null, 2)}\n`;
}

module.exports = { buildVectorFile, REPLY_MESSAGE, VECTOR_FILE };

if (require.main === module) {
  const text = buildVectorFile();
  if (process.argv[2] === "--check") {
    const current = fs.existsSync(VECTOR_FILE) ? fs.readFileSync(VECTOR_FILE, "utf8") : "";
    if (current !== text) {
      console.error(`${VECTOR_FILE} is stale. Run: node scripts/generate-transport-vectors.js`);
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(VECTOR_FILE, text);
    console.log(`Wrote ${VECTOR_FILE}`);
  }
}
