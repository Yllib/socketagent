import * as crypto from "crypto";
import * as nacl from "tweetnacl";
import { isRecord } from "./value-guards";

/**
 * Transport v2, the parts every path shares (wire spec sections 1 to 4):
 * the key derivations, the handshake prologue, the `hs1` and `hs2` frames,
 * the approval code and the record channel that seals frames once a
 * handshake is done. The handshake itself is noise-ikpsk1.ts.
 *
 * Nothing here touches a socket or the state file. The responder and the
 * sockets that carry it build on these functions, and
 * scripts/generate-transport-vectors.js writes the file the app is checked
 * against from them.
 */
export const TRANSPORT_VERSION = 2;

/** Where a handshake arrives. The responder takes it from the socket, never from the frame. */
export type TransportPath = "relay" | "direct" | "local-request";
/** What a channel carries. Device channels are control and bulk. */
export type HandshakeLane = "control" | "bulk" | "link" | "transfer";

const SECRET_LENGTH = 32;
const ZERO_SALT = Buffer.alloc(32);

/** HKDF-SHA256 with a salt of 32 zero bytes and one output block, as spec section 1 spells it out. */
export function hkdf(inputKeyMaterial: Uint8Array, info: string, length: number): Buffer {
  if (length < 1 || length > 32) throw new Error("HKDF output must be 1 to 32 bytes");
  const pseudoRandomKey = crypto.createHmac("sha256", ZERO_SALT).update(inputKeyMaterial).digest();
  const block = crypto.createHmac("sha256", pseudoRandomKey).update(Buffer.from(info, "ascii")).update(Uint8Array.of(1)).digest();
  return block.subarray(0, length);
}

function requireSecret(secret: Uint8Array): void {
  if (secret.length !== SECRET_LENGTH) throw new Error(`A secret must be ${SECRET_LENGTH} bytes, got ${secret.length}`);
}

/** The Noise PSK for a pairing, link or transfer secret. The raw secret is never a key itself. */
export function derivePsk(secret: Uint8Array): Buffer {
  requireSecret(secret);
  return hkdf(secret, "socketagent/v2/psk", 32);
}

/**
 * The public tag of a secret, 8 hex characters. It rides in `hs1` so a
 * responder can drop a message for a secret it does not hold before any key
 * agreement.
 */
export function secretTag(secret: Uint8Array): string {
  requireSecret(secret);
  return hkdf(secret, "socketagent/v2/secret-id", 4).toString("hex");
}

/** The key push notifications are sealed under, from a pairing secret. */
export function derivePushKey(pairingSecret: Uint8Array): Buffer {
  requireSecret(pairingSecret);
  return hkdf(pairingSecret, "socketagent/v2/push", 32);
}

/** The PSK of the `local-request` path. A public constant: that path proves a key, not a secret. */
export const LOCAL_PSK: Buffer = hkdf(ZERO_SALT, "socketagent/v2/local-request", 32);
/** The `k` an initiator sends on `local-request`. The responder ignores it. */
export const LOCAL_REQUEST_TAG = "00000000";

/** The six digits both ends show while a device waits for Allow. New for every handshake. */
export function approvalCode(handshakeHash: Uint8Array): string {
  if (handshakeHash.length !== 32) throw new Error("A handshake hash is 32 bytes");
  const value = hkdf(handshakeHash, "socketagent/v2/approval-code", 4).readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

const PROLOGUE_LABEL = "socketagent-transport-v2";
const PATHS: readonly TransportPath[] = ["relay", "direct", "local-request"];
const LANES: readonly HandshakeLane[] = ["control", "bulk", "link", "transfer"];

/** Whether spec section 3.2 allows this path and lane together. */
export function isValidPathAndLane(path: TransportPath, lane: HandshakeLane): boolean {
  if (path === "local-request") return lane === "control";
  if (path === "direct") return lane === "control" || lane === "bulk";
  return true;
}

/**
 * The bytes both sides mix into the handshake before message 1. `context` is
 * the computer's room ID for control and bulk, the link room ID for a link,
 * the job ID for a transfer, and empty on `local-request`.
 */
export function buildPrologue(path: TransportPath, lane: HandshakeLane, context: string): Buffer {
  if (!isValidPathAndLane(path, lane)) throw new Error(`No handshake runs on ${path} ${lane}`);
  if (path === "local-request" && context !== "") throw new Error("The local-request prologue has no context");
  const zero = Uint8Array.of(0);
  return Buffer.concat([
    Buffer.from(PROLOGUE_LABEL, "ascii"), zero,
    Buffer.from(path, "ascii"), zero,
    Buffer.from(lane, "ascii"), zero,
    Buffer.from(context, "utf8"),
  ]);
}

// ── Sizes, spec section 3.8 ──

/** The largest payload either handshake message may carry. */
export const MAX_HANDSHAKE_PAYLOAD_BYTES = 2048;
/** Noise message 1 is 96 bytes plus its payload. */
export const MAX_NOISE_MESSAGE_1_BYTES = 96 + MAX_HANDSHAKE_PAYLOAD_BYTES;
/** Noise message 2 is 48 bytes plus its payload. */
export const MAX_NOISE_MESSAGE_2_BYTES = 48 + MAX_HANDSHAKE_PAYLOAD_BYTES;
/** The largest whole `hs1` or `hs2` text frame. Checked before the frame is parsed. */
export const MAX_HANDSHAKE_FRAME_BYTES = 4096;

// ── Handshake frames, spec section 3.3 ──

export interface Hs1Frame {
  path: TransportPath;
  lane: HandshakeLane;
  /** The tag of the secret the initiator used. */
  tag: string;
  /** The raw Noise message 1. */
  message: Buffer;
}

/** Standard base64 with padding, and nothing a lenient decoder would skip over. */
function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

/** The exact `hs1` text frame. Field order is part of the shared test file. */
export function encodeHs1Frame(frame: Hs1Frame): string {
  return JSON.stringify({ type: "hs1", v: TRANSPORT_VERSION, path: frame.path, lane: frame.lane, k: frame.tag, d: frame.message.toString("base64") });
}

/** The exact `hs2` text frame. */
export function encodeHs2Frame(message: Uint8Array): string {
  return JSON.stringify({ type: "hs2", v: TRANSPORT_VERSION, d: Buffer.from(message).toString("base64") });
}

/**
 * Reads an `hs1` text frame. Null for anything this side does not speak: an
 * oversized frame, another version, a path and lane that cannot go together,
 * or a Noise message outside its size limits. The caller stays silent.
 */
export function parseHs1Frame(raw: string): Hs1Frame | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_HANDSHAKE_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "hs1" || parsed.v !== TRANSPORT_VERSION) return null;
  const path = PATHS.find((candidate) => candidate === parsed.path);
  const lane = LANES.find((candidate) => candidate === parsed.lane);
  if (!path || !lane || !isValidPathAndLane(path, lane)) return null;
  if (typeof parsed.k !== "string" || !/^[0-9a-f]{8}$/.test(parsed.k)) return null;
  const message = decodeBase64(parsed.d);
  if (!message || message.length < 96 || message.length > MAX_NOISE_MESSAGE_1_BYTES) return null;
  return { path, lane, tag: parsed.k, message };
}

/** Reads an `hs2` text frame and returns its Noise message 2, or null when it is not one this side speaks. */
export function parseHs2Frame(raw: string): Buffer | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_HANDSHAKE_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "hs2" || parsed.v !== TRANSPORT_VERSION) return null;
  const message = decodeBase64(parsed.d);
  return message && message.length >= 48 && message.length <= MAX_NOISE_MESSAGE_2_BYTES ? message : null;
}

// The session-transfer socket carries binary frames only. 0x48 cannot start
// a record there, because a record starts with 0x01 or 0x02.
const BINARY_HANDSHAKE_MARKER = 0x48;
/** The largest binary `hs1`: two marker bytes, the 4-byte tag and Noise message 1. */
export const MAX_BINARY_HS1_BYTES = 6 + MAX_NOISE_MESSAGE_1_BYTES;
/** The largest binary `hs2`: two marker bytes and Noise message 2. */
export const MAX_BINARY_HS2_BYTES = 2 + MAX_NOISE_MESSAGE_2_BYTES;

/** `hs1` on the session-transfer socket: 0x48 0x01, the tag, then Noise message 1. */
export function encodeBinaryHs1(tag: string, message: Uint8Array): Buffer {
  if (!/^[0-9a-f]{8}$/.test(tag)) throw new Error("A secret tag is 8 hex characters");
  return Buffer.concat([Uint8Array.of(BINARY_HANDSHAKE_MARKER, 1), Buffer.from(tag, "hex"), message]);
}

/** `hs2` on the session-transfer socket: 0x48 0x02, then Noise message 2. */
export function encodeBinaryHs2(message: Uint8Array): Buffer {
  return Buffer.concat([Uint8Array.of(BINARY_HANDSHAKE_MARKER, 2), message]);
}

// ── Handshake payloads, spec section 3.4 ──

/** A handshake payload as bytes. Throws when it would pass the size limit a receiver enforces. */
export function encodeHandshakePayload(payload: Record<string, unknown>): Buffer {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.length > MAX_HANDSHAKE_PAYLOAD_BYTES) throw new Error(`A handshake payload is at most ${MAX_HANDSHAKE_PAYLOAD_BYTES} bytes`);
  return bytes;
}

/** A received handshake payload, or null when it is too big or not a JSON object. */
export function parseHandshakePayload(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length > MAX_HANDSHAKE_PAYLOAD_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What the responder says in message 2. `refused` tells a peer that proved the secret why it is not let in. */
export type HandshakeStatus = "open" | "pending" | "refused";
export type HandshakeRefusal = "too_many_pending" | "not_approved";

/** The message 2 payload. Field order is part of the shared test file. */
export function handshakeAnswer(status: HandshakeStatus, serverVersion: string, reason?: HandshakeRefusal): Record<string, unknown> {
  return status === "refused" ? { status, reason: reason ?? "not_approved", server: serverVersion } : { status, server: serverVersion };
}

/** The first record of every v2 channel, sent by the initiator. */
export const TRANSPORT_READY_MESSAGE = JSON.stringify({ type: "transport_ready" });

// ── Record layer, spec section 4 ──

export type HandshakeRole = "initiator" | "responder";

const FROM_INITIATOR = 1;
const FROM_RESPONDER = 2;
const NONCE_LENGTH = nacl.secretbox.nonceLength;

/** A sealed text frame: `{"n":"<base64 nonce>","c":"<base64 box>"}`. */
export interface SealedText {
  n: string;
  c: string;
}

/** What a socket needs from a channel, whichever handshake made it. relay-crypto's PeerChannel fits too. */
export interface FrameChannel {
  sealText(message: string): SealedText;
  openText(envelope: SealedText): string;
  sealBinary(plaintext: Uint8Array): Buffer;
  openBinary(envelope: Uint8Array): Uint8Array;
}

/** A frame the channel refused. The channel is closed from then on. */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

export interface TransportChannelKeys {
  /** This side's role in the handshake that made the keys. */
  role: HandshakeRole;
  /** Raw 32-byte key for frames this side sends. */
  sendKey: Uint8Array;
  /** Raw 32-byte key for frames this side receives. */
  receiveKey: Uint8Array;
}

/**
 * The record layer of one v2 channel: XSalsa20-Poly1305 secretbox with a
 * separate key and counter per direction, shared by text and binary frames.
 * Build it from the keys a finished handshake hands over.
 *
 * Seal a frame at the moment it goes onto the socket, because each seal
 * spends a counter. Any frame that does not open throws RecordError and
 * closes the channel: every later seal and open throws too, and the caller
 * closes the socket or drops the relay peer.
 */
export class TransportChannel implements FrameChannel {
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  private readonly sendDirection: number;
  private readonly receiveDirection: number;
  private sent = 0;
  private received = 0;
  private failed = false;

  constructor(keys: TransportChannelKeys) {
    if (keys.sendKey.length !== 32 || keys.receiveKey.length !== 32) throw new Error("A channel key is 32 bytes");
    this.sendKey = Uint8Array.from(keys.sendKey);
    this.receiveKey = Uint8Array.from(keys.receiveKey);
    this.sendDirection = keys.role === "initiator" ? FROM_INITIATOR : FROM_RESPONDER;
    this.receiveDirection = keys.role === "initiator" ? FROM_RESPONDER : FROM_INITIATOR;
  }

  /** Whether a frame was refused, which closes the channel for good. */
  get closed(): boolean {
    return this.failed;
  }

  private fail(message: string): never {
    this.failed = true;
    throw new RecordError(message);
  }

  private seal(plaintext: Uint8Array): { nonce: Uint8Array; box: Uint8Array } {
    if (this.failed) throw new RecordError("The channel is closed");
    const nonce = new Uint8Array(NONCE_LENGTH);
    nonce[0] = this.sendDirection;
    new DataView(nonce.buffer).setBigUint64(16, BigInt(++this.sent));
    return { nonce, box: nacl.secretbox(plaintext, nonce, this.sendKey) };
  }

  private open(box: Uint8Array, nonce: Uint8Array): Uint8Array {
    if (this.failed) throw new RecordError("The channel is closed");
    if (nonce.length !== NONCE_LENGTH) this.fail("A record nonce is 24 bytes");
    if (nonce[0] !== this.receiveDirection) this.fail("Frame sealed for the other direction");
    for (let index = 1; index < 16; index++) if (nonce[index] !== 0) this.fail("Record nonce padding is not zero");
    const counter = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(16);
    if (counter <= BigInt(this.received)) this.fail("Replayed or reordered frame");
    const plaintext = nacl.secretbox.open(box, nonce, this.receiveKey);
    if (!plaintext) this.fail("The record did not open");
    // Counters stay below 2^53, far past any connection's frame count.
    this.received = Number(counter);
    return plaintext;
  }

  sealText(message: string): SealedText {
    const { nonce, box } = this.seal(Buffer.from(message, "utf8"));
    return { n: Buffer.from(nonce).toString("base64"), c: Buffer.from(box).toString("base64") };
  }

  openText(envelope: SealedText): string {
    const nonce = decodeBase64(envelope.n);
    const box = decodeBase64(envelope.c);
    if (!nonce || !box) this.fail("A sealed text frame is two base64 strings");
    return Buffer.from(this.open(box, nonce)).toString("utf8");
  }

  /** The packed binary frame: the 24-byte nonce, then the box. */
  sealBinary(plaintext: Uint8Array): Buffer {
    const { nonce, box } = this.seal(plaintext);
    return Buffer.concat([nonce, box]);
  }

  openBinary(envelope: Uint8Array): Uint8Array {
    if (envelope.length < NONCE_LENGTH) this.fail("A binary record is shorter than its nonce");
    return this.open(Uint8Array.from(envelope.subarray(NONCE_LENGTH)), Uint8Array.from(envelope.subarray(0, NONCE_LENGTH)));
  }
}

/** The sealed text frame as it goes onto the socket. */
export function sealedTextFrame(channel: FrameChannel, message: string): string {
  return JSON.stringify(channel.sealText(message));
}
