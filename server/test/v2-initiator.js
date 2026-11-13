const { generateKeyPair, initiateHandshake } = require("#server/noise-ikpsk1");
const {
  approvalCode,
  buildPrologue,
  derivePsk,
  encodeHandshakePayload,
  encodeHs1Frame,
  parseHandshakePayload,
  parseHs2Frame,
  secretTag,
  TransportChannel,
  TRANSPORT_READY_MESSAGE,
} = require("#server/transport-v2");

/**
 * The device's half of a v2 handshake, for tests of the computer's half.
 * `dial` writes `hs1`. `finish(hs2)` reads the answer and returns the
 * device's end of the channel.
 *
 * @param {{
 *   serverKey: Uint8Array,
 *   secret: string,
 *   roomId: string,
 *   path?: "relay" | "direct",
 *   lane?: "control" | "bulk" | "link",
 *   keys?: import("#server/noise-ikpsk1").NoiseKeyPair,
 *   payload?: Record<string, unknown>,
 * }} options `secret` is the base64 pairing secret the device holds.
 */
function dial(options) {
  const { serverKey, roomId, path = "relay", lane = "control", keys = generateKeyPair() } = options;
  const secret = Buffer.from(options.secret, "base64");
  const payload = options.payload ?? { app: "1.2.0", name: "Pixel 9", platform: "android", caps: {} };
  const handshake = initiateHandshake({
    prologue: buildPrologue(path, lane, roomId),
    staticKeyPair: keys,
    responderStaticKey: serverKey,
    psk: derivePsk(secret),
    payload: encodeHandshakePayload(payload),
  });
  return {
    keys,
    publicKey: Buffer.from(keys.publicKey).toString("base64"),
    hs1: encodeHs1Frame({ path, lane, tag: secretTag(secret), message: Buffer.from(handshake.message1) }),
    /** @param {string} hs2 */
    finish(hs2) {
      const message2 = parseHs2Frame(hs2);
      if (!message2) throw new Error("Not an hs2 frame");
      const result = handshake.readMessage2(message2);
      const channel = new TransportChannel({ role: "initiator", sendKey: result.sendKey, receiveKey: result.receiveKey });
      return {
        answer: parseHandshakePayload(result.payload) ?? {},
        channel,
        code: approvalCode(result.handshakeHash),
        /** The sealed `transport_ready` text frame, as it goes onto the socket. */
        ready: () => JSON.stringify(channel.sealText(TRANSPORT_READY_MESSAGE)),
        /** @param {Record<string, unknown>} message */
        seal: (message) => JSON.stringify(channel.sealText(JSON.stringify(message))),
      };
    },
  };
}

module.exports = { dial };
