import {
  dh,
  generateKeyPair,
  NOISE_KEY_LENGTH,
  NOISE_TAG_LENGTH,
  NoiseError,
  type NoiseKeyPair,
  requireLength,
  SymmetricState,
} from "./noise-symmetric";

export { generateKeyPair, keyPairFromSecretKey, NoiseError, NOISE_KEY_LENGTH } from "./noise-symmetric";
export type { NoiseFailure, NoiseKeyPair } from "./noise-symmetric";

/**
 * The Noise_IKpsk1_25519_ChaChaPoly_SHA256 handshake, from the Noise Protocol
 * Framework specification, revision 34 (pattern in section 9.4):
 *
 *   <- s
 *   ...
 *   -> e, es, s, ss, psk
 *   <- e, ee, se
 *
 * The initiator already knows the responder's static key. Two messages, then
 * both sides hold two raw 32-byte transport keys, one per direction, and the
 * handshake hash. Noise's own transport messages are not used: the caller's
 * record layer takes the keys.
 *
 * Initiator:
 *
 *   const handshake = initiateHandshake({ prologue, staticKeyPair, responderStaticKey, psk, payload });
 *   send(handshake.message1);
 *   const { payload, sendKey, receiveKey, handshakeHash } = handshake.readMessage2(received);
 *
 * Responder, which may hold several secrets and picks by who is asking:
 *
 *   const message1 = readMessage1({ prologue, staticKeyPair, message });
 *   for (const psk of candidatesFor(message1.initiatorStaticKey)) {
 *     const accepted = message1.tryPsk(psk);
 *     if (!accepted) continue;
 *     const { message2, sendKey, receiveKey, handshakeHash } = accepted.writeMessage2(payload);
 *     ...
 *   }
 *
 * Every refusal throws NoiseError, except a PSK that does not fit, which
 * makes tryPsk return null. The caller answers a refused peer with nothing.
 *
 * The core keeps no record of messages it has seen. A recorded message 1
 * that is played again is accepted again, as the pattern allows, and gets a
 * message 2 under a new ephemeral key. Whoever replayed it cannot work out
 * the transport keys, so the caller treats a peer as present only once a
 * first record opens under them.
 */
export const NOISE_PROTOCOL_NAME = "Noise_IKpsk1_25519_ChaChaPoly_SHA256";

/** The longest handshake message Noise allows, in bytes. */
export const NOISE_MAX_MESSAGE_LENGTH = 65535;
/** Message 1 is the ephemeral key, the sealed static key and the sealed payload. */
export const NOISE_MESSAGE_1_OVERHEAD = NOISE_KEY_LENGTH + NOISE_KEY_LENGTH + NOISE_TAG_LENGTH + NOISE_TAG_LENGTH;
/** Message 2 is the ephemeral key and the sealed payload. */
export const NOISE_MESSAGE_2_OVERHEAD = NOISE_KEY_LENGTH + NOISE_TAG_LENGTH;

/** What a finished handshake gives the side that holds it. */
export interface NoiseTransportKeys {
  /** Raw 32-byte key for records this side sends. */
  sendKey: Uint8Array;
  /** Raw 32-byte key for records this side receives. */
  receiveKey: Uint8Array;
  /** 32 bytes that are the same on both sides and unique to this handshake. */
  handshakeHash: Uint8Array;
}

export interface NoiseInitiatorOptions {
  /** Context both sides must agree on. Any difference fails the handshake. */
  prologue: Uint8Array;
  staticKeyPair: NoiseKeyPair;
  /** The responder's static public key, known beforehand. */
  responderStaticKey: Uint8Array;
  /** The 32-byte pre-shared key. */
  psk: Uint8Array;
  /** Sent sealed in message 1. Readable only by the responder, and only with the PSK. */
  payload: Uint8Array;
  /** Tests and vector generation only. A real handshake leaves this out and gets a random key. */
  fixedEphemeralKeyPair?: NoiseKeyPair;
}

export interface NoiseInitiatorHandshake {
  /** Message 1, ready to send. */
  readonly message1: Uint8Array;
  /**
   * Reads message 2 and finishes the handshake. A message that does not
   * verify throws and leaves the handshake as it was, so a forged answer
   * does not stop the real one from being read afterwards.
   */
  readMessage2(message: Uint8Array): NoiseTransportKeys & { payload: Uint8Array };
}

export interface NoiseResponderOptions {
  /** Context both sides must agree on. Any difference fails the handshake. */
  prologue: Uint8Array;
  staticKeyPair: NoiseKeyPair;
  /** Message 1 as received. */
  message: Uint8Array;
}

/** A message 1 read up to the `psk` token. */
export interface NoiseMessage1 {
  /**
   * The static public key the initiator claims. Nothing has proved it yet:
   * anyone who knows the responder's public key can name any key here. Use it
   * only to choose which PSKs to try. It is proved once tryPsk succeeds.
   */
  readonly initiatorStaticKey: Uint8Array;
  /**
   * Finishes reading the message with one candidate PSK. Returns null when
   * the PSK does not fit, or when the sender does not hold the private half
   * of initiatorStaticKey. Each call costs one key derivation and one AEAD
   * check, and any number of candidates may be tried in any order.
   */
  tryPsk(psk: Uint8Array): NoiseAcceptedMessage1 | null;
}

/** A message 1 that verified: its sender holds the PSK and the private half of initiatorStaticKey. */
export interface NoiseAcceptedMessage1 {
  readonly initiatorStaticKey: Uint8Array;
  /** The payload the initiator sealed into message 1. */
  readonly payload: Uint8Array;
  /**
   * Writes message 2 and finishes the handshake. Callable once.
   * `fixedEphemeralKeyPair` is for tests and vector generation only.
   */
  writeMessage2(payload: Uint8Array, fixedEphemeralKeyPair?: NoiseKeyPair): NoiseTransportKeys & { message2: Uint8Array };
}

/** The state both sides start from: protocol name, prologue, then the pre-message `<- s`. */
function initialState(prologue: Uint8Array, responderStaticKey: Uint8Array): SymmetricState {
  const state = SymmetricState.initialize(NOISE_PROTOCOL_NAME);
  state.mixHash(prologue);
  state.mixHash(responderStaticKey);
  return state;
}

function requireKeyPair(name: string, keyPair: NoiseKeyPair): void {
  requireLength(`${name} public key`, keyPair.publicKey, NOISE_KEY_LENGTH);
  requireLength(`${name} secret key`, keyPair.secretKey, NOISE_KEY_LENGTH);
}

function requireMessageLength(name: string, length: number, overhead: number): void {
  if (length < overhead || length > NOISE_MAX_MESSAGE_LENGTH) {
    throw new NoiseError("malformed", `${name} must be ${overhead} to ${NOISE_MAX_MESSAGE_LENGTH} bytes, got ${length}`);
  }
}

/**
 * The initiator's half. Writes message 1 at once and returns it with the
 * function that reads message 2. Throws when the responder's key is low order.
 */
export function initiateHandshake(options: NoiseInitiatorOptions): NoiseInitiatorHandshake {
  const { staticKeyPair, responderStaticKey, psk, payload } = options;
  requireKeyPair("Initiator static", staticKeyPair);
  requireLength("Responder static key", responderStaticKey, NOISE_KEY_LENGTH);
  requireLength("PSK", psk, NOISE_KEY_LENGTH);
  requireMessageLength("Message 1", payload.length + NOISE_MESSAGE_1_OVERHEAD, NOISE_MESSAGE_1_OVERHEAD);
  const ephemeral = options.fixedEphemeralKeyPair ?? generateKeyPair();
  requireKeyPair("Initiator ephemeral", ephemeral);

  const state = initialState(options.prologue, responderStaticKey);
  // e. A PSK handshake also mixes each ephemeral public key into the key.
  state.mixHash(ephemeral.publicKey);
  state.mixKey(ephemeral.publicKey);
  // es
  state.mixKey(dh(ephemeral.secretKey, responderStaticKey));
  // s
  const sealedStaticKey = state.encryptAndHash(staticKeyPair.publicKey);
  // ss
  state.mixKey(dh(staticKeyPair.secretKey, responderStaticKey));
  // psk
  state.mixKeyAndHash(psk);
  const sealedPayload = state.encryptAndHash(payload);

  return {
    message1: Buffer.concat([ephemeral.publicKey, sealedStaticKey, sealedPayload]),
    readMessage2(message) {
      requireMessageLength("Message 2", message.length, NOISE_MESSAGE_2_OVERHEAD);
      const next = state.clone();
      const responderEphemeralKey = message.subarray(0, NOISE_KEY_LENGTH);
      // e
      next.mixHash(responderEphemeralKey);
      next.mixKey(responderEphemeralKey);
      // ee
      next.mixKey(dh(ephemeral.secretKey, responderEphemeralKey));
      // se
      next.mixKey(dh(staticKeyPair.secretKey, responderEphemeralKey));
      const received = next.decryptAndHash(message.subarray(NOISE_KEY_LENGTH));
      const [initiatorKey, responderKey] = next.split();
      return { payload: received, sendKey: initiatorKey, receiveKey: responderKey, handshakeHash: next.handshakeHash };
    },
  };
}

/**
 * The responder's half. Reads message 1 as far as the `psk` token, which is
 * every Diffie-Hellman step the message needs, and returns the initiator's
 * claimed static key with the function that tries a PSK. Throws when the
 * message is not for this key and prologue, is tampered with, or carries a
 * low-order key.
 */
export function readMessage1(options: NoiseResponderOptions): NoiseMessage1 {
  const { staticKeyPair, message } = options;
  requireKeyPair("Responder static", staticKeyPair);
  requireMessageLength("Message 1", message.length, NOISE_MESSAGE_1_OVERHEAD);
  const staticKeyEnd = NOISE_KEY_LENGTH + NOISE_KEY_LENGTH + NOISE_TAG_LENGTH;
  // Copied, so the caller may reuse its buffer while candidates are tried.
  const initiatorEphemeralKey = Buffer.from(message.subarray(0, NOISE_KEY_LENGTH));
  const sealedPayload = Buffer.from(message.subarray(staticKeyEnd));

  const state = initialState(options.prologue, staticKeyPair.publicKey);
  // e
  state.mixHash(initiatorEphemeralKey);
  state.mixKey(initiatorEphemeralKey);
  // es
  state.mixKey(dh(staticKeyPair.secretKey, initiatorEphemeralKey));
  // s
  const initiatorStaticKey = state.decryptAndHash(message.subarray(NOISE_KEY_LENGTH, staticKeyEnd));
  // ss
  state.mixKey(dh(staticKeyPair.secretKey, initiatorStaticKey));

  return {
    initiatorStaticKey,
    tryPsk(psk) {
      requireLength("PSK", psk, NOISE_KEY_LENGTH);
      const candidate = state.clone();
      // psk
      candidate.mixKeyAndHash(psk);
      let payload: Uint8Array;
      try {
        payload = candidate.decryptAndHash(sealedPayload);
      } catch (error) {
        if (error instanceof NoiseError && error.reason === "decrypt") return null;
        throw error;
      }
      let written = false;
      return {
        initiatorStaticKey,
        payload,
        writeMessage2(responsePayload, fixedEphemeralKeyPair) {
          if (written) throw new Error("Message 2 was already written for this handshake");
          requireMessageLength("Message 2", responsePayload.length + NOISE_MESSAGE_2_OVERHEAD, NOISE_MESSAGE_2_OVERHEAD);
          const ephemeral = fixedEphemeralKeyPair ?? generateKeyPair();
          requireKeyPair("Responder ephemeral", ephemeral);
          written = true;
          // e
          candidate.mixHash(ephemeral.publicKey);
          candidate.mixKey(ephemeral.publicKey);
          // ee
          candidate.mixKey(dh(ephemeral.secretKey, initiatorEphemeralKey));
          // se
          candidate.mixKey(dh(ephemeral.secretKey, initiatorStaticKey));
          const sealedResponse = candidate.encryptAndHash(responsePayload);
          const [initiatorKey, responderKey] = candidate.split();
          return {
            message2: Buffer.concat([ephemeral.publicKey, sealedResponse]),
            sendKey: responderKey,
            receiveKey: initiatorKey,
            handshakeHash: candidate.handshakeHash,
          };
        },
      };
    },
  };
}
