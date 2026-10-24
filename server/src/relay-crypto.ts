import { errorMessage, isRecord, parseJsonObject, unknownArray } from "./value-guards";
import * as nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface EncryptedEnvelope {
  n: string; // base64 nonce
  c: string; // base64 ciphertext
}

/** Generate a new NaCl box X25519 key pair */
export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

// nacl.box redoes the X25519 key exchange on every call. The shared key per
// key pair is cached instead, so each message costs only the symmetric cipher.
const sharedKeys = new WeakMap<Uint8Array, Map<string, Uint8Array>>();

function sharedKey(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  let byPeer = sharedKeys.get(mySecretKey);
  if (!byPeer) {
    byPeer = new Map();
    sharedKeys.set(mySecretKey, byPeer);
  }
  const peer = Buffer.from(theirPublicKey).toString("base64");
  let key = byPeer.get(peer);
  if (!key) {
    key = nacl.box.before(theirPublicKey, mySecretKey);
    byPeer.set(peer, key);
  }
  return key;
}

/** Encrypt a message string using NaCl box */
export function encrypt(
  message: string,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): EncryptedEnvelope {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(message);
  const ciphertext = nacl.box.after(messageBytes, nonce, sharedKey(theirPublicKey, mySecretKey));
  if (!ciphertext) throw new Error("Encryption failed");
  return {
    n: Buffer.from(nonce).toString("base64"),
    c: Buffer.from(ciphertext).toString("base64"),
  };
}

/** Decrypt an encrypted envelope using NaCl box */
export function decrypt(
  envelope: EncryptedEnvelope,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): string {
  const nonce = new Uint8Array(Buffer.from(envelope.n, "base64"));
  const ciphertext = new Uint8Array(Buffer.from(envelope.c, "base64"));
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey(theirPublicKey, mySecretKey));
  if (!plaintext) throw new Error("Decryption failed — invalid key or corrupted message");
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt arbitrary bytes into a packed binary envelope: [24-byte nonce | ciphertext].
 * Sent as a WebSocket binary frame, no JSON wrapping, no base64 — saves the ~33%
 * inflation the {n, c} envelope incurs on every message.
 */
export function encryptBinary(
  plaintext: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): Buffer {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey(theirPublicKey, mySecretKey));
  if (!ciphertext) throw new Error("Encryption failed");
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
}

/** Decrypt a packed binary envelope produced by encryptBinary. */
export function decryptBinary(
  envelope: Buffer | Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): Uint8Array {
  if (envelope.length < nacl.box.nonceLength) throw new Error("Envelope too short");
  const nonce = new Uint8Array(envelope.subarray(0, nacl.box.nonceLength));
  const ciphertext = new Uint8Array(envelope.subarray(nacl.box.nonceLength));
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey(theirPublicKey, mySecretKey));
  if (!plaintext) throw new Error("Decryption failed — invalid key or corrupted message");
  return plaintext;
}

/** Encode a Uint8Array as base64 string */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 string to Uint8Array */
export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Load key pair from file, or generate and save a new one */
export function loadOrCreateKeyPair(configPath: string): KeyPair {
  if (fs.existsSync(configPath)) {
    const data = parseJsonObject(fs.readFileSync(configPath, "utf-8"));
    if (typeof data.publicKey !== "string" || typeof data.secretKey !== "string") throw new Error("Invalid relay key file");
    return {
      publicKey: fromBase64(data.publicKey),
      secretKey: fromBase64(data.secretKey),
    };
  }

  const kp = generateKeyPair();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      publicKey: toBase64(kp.publicKey),
      secretKey: toBase64(kp.secretKey),
    }),
    { mode: 0o600 } // owner-only read/write
  );
  console.log(`Generated new relay key pair → ${configPath}`);
  return kp;
}

/**
 * Session keys (version 1). The static box above encrypts every frame two
 * keys ever exchange, with random nonces, so a frame recorded off the relay
 * opens again later or on another connection. A session instead agrees a
 * fresh key for one connection and numbers its nonces, so each frame opens
 * once, in order, on the connection it was sealed for.
 *
 * The initiator (the phone, or a computer joining a link room) adds
 * `session: { v, key, proof }` to its plaintext key_exchange: `key` is a new
 * X25519 public key and `proof` seals that key under the static box, so only
 * the holder of the static secret can offer it. The responder answers in
 * key_exchange_ack with its own new key, sealed together with the offer's.
 * Both sides then use nacl.box.before over the two new keys. A peer that
 * does not know the field ignores it and both sides keep the static box.
 */
export const SESSION_KEY_VERSION = 1;

const OFFER_LABEL = new TextEncoder().encode("socketagent session offer v1");
const ANSWER_LABEL = new TextEncoder().encode("socketagent session answer v1");
const KEY_LENGTH = nacl.box.publicKeyLength;

// Byte 0 of a session nonce names the sender, so a frame cannot be reflected
// back to the side that sealed it. Bytes 16-23 hold the frame counter.
const FROM_INITIATOR = 1;
const FROM_RESPONDER = 2;

export type SessionRole = "initiator" | "responder";

interface SessionFields {
  v: number;
  key: string;
  proof: string;
}

/**
 * Public keys that have proven they speak session keys. Such a key is refused
 * the static box from then on, so stripping the session field off its
 * handshake fails loudly instead of downgrading it to a replayable channel.
 */
export interface SessionKeyedPeers {
  has(publicKey: string): boolean;
  add(publicKey: string): void;
}

/** File-backed set of session-keyed peer keys. Without a path it lives in memory. */
export class SessionKeyedPeerStore implements SessionKeyedPeers {
  private readonly keys = new Set<string>();

  constructor(private readonly filePath?: string) {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const data = parseJsonObject(fs.readFileSync(filePath, "utf-8"));
      for (const key of unknownArray(data.keys)) if (typeof key === "string") this.keys.add(key);
    } catch (err) {
      console.error(`[Crypto] Could not read ${filePath}: ${errorMessage(err)}`);
    }
  }

  has(publicKey: string): boolean {
    return this.keys.has(publicKey);
  }

  add(publicKey: string): void {
    if (this.keys.has(publicKey)) return;
    this.keys.add(publicKey);
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ keys: Array.from(this.keys) }), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

/** A legacy key exchange from a key that has spoken session keys before. */
export class SessionKeyRequiredError extends Error {
  constructor() {
    super("Peer has used session keys before; refusing the static box");
  }
}

/**
 * Seals and opens the frames of one connection. A session channel numbers its
 * nonces and refuses a frame whose number is not above the last one opened,
 * which rejects replays and reordering. A legacy channel is the static box
 * that peers without session keys speak: random nonces, no replay check.
 */
export class PeerChannel {
  private sent = 0;
  private received = 0;

  private constructor(
    private readonly key: Uint8Array,
    private readonly session: { send: number; receive: number } | null,
  ) {}

  static legacy(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): PeerChannel {
    return new PeerChannel(sharedKey(theirPublicKey, mySecretKey), null);
  }

  static session(key: Uint8Array, role: SessionRole): PeerChannel {
    return new PeerChannel(key, role === "initiator"
      ? { send: FROM_INITIATOR, receive: FROM_RESPONDER }
      : { send: FROM_RESPONDER, receive: FROM_INITIATOR });
  }

  /** Whether this channel refuses replayed frames. */
  get sessionKeyed(): boolean {
    return this.session !== null;
  }

  private nextNonce(): Uint8Array {
    if (!this.session) return nacl.randomBytes(nacl.box.nonceLength);
    const nonce = new Uint8Array(nacl.box.nonceLength);
    nonce[0] = this.session.send;
    writeCounter(nonce, ++this.sent);
    return nonce;
  }

  private seal(plaintext: Uint8Array): { nonce: Uint8Array; box: Uint8Array } {
    const nonce = this.nextNonce();
    return { nonce, box: nacl.secretbox(plaintext, nonce, this.key) };
  }

  private open(box: Uint8Array, nonce: Uint8Array): Uint8Array {
    if (nonce.length !== nacl.box.nonceLength) throw new Error("Invalid nonce");
    const plaintext = nacl.secretbox.open(box, nonce, this.key);
    if (!plaintext) throw new Error("Decryption failed — invalid key or corrupted message");
    // The nonce is authenticated, so it is only read once the box opens.
    if (this.session) {
      const counter = readCounter(nonce);
      if (nonce[0] !== this.session.receive || counter === null) throw new Error("Frame sealed for the other direction");
      if (counter <= this.received) throw new Error("Replayed or reordered frame");
      this.received = counter;
    }
    return plaintext;
  }

  sealText(message: string): EncryptedEnvelope {
    const { nonce, box } = this.seal(new TextEncoder().encode(message));
    return { n: toBase64(nonce), c: toBase64(box) };
  }

  openText(envelope: EncryptedEnvelope): string {
    return new TextDecoder().decode(this.open(fromBase64(envelope.c), fromBase64(envelope.n)));
  }

  /** Packed binary envelope: [24-byte nonce | ciphertext], as encryptBinary. */
  sealBinary(plaintext: Uint8Array): Buffer {
    const { nonce, box } = this.seal(plaintext);
    return Buffer.concat([nonce, box]);
  }

  openBinary(envelope: Buffer | Uint8Array): Uint8Array {
    if (envelope.length < nacl.box.nonceLength) throw new Error("Envelope too short");
    return this.open(
      new Uint8Array(envelope.subarray(nacl.box.nonceLength)),
      new Uint8Array(envelope.subarray(0, nacl.box.nonceLength)),
    );
  }
}

// Counters stay below 2^53, far past any connection's frame count.
function writeCounter(nonce: Uint8Array, counter: number): void {
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setUint32(16, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(20, counter >>> 0);
}

/** The counter of a session nonce, or null when its padding bytes are not zero. */
function readCounter(nonce: Uint8Array): number | null {
  for (let i = 1; i < 16; i++) if (nonce[i] !== 0) return null;
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  return view.getUint32(16) * 0x1_0000_0000 + view.getUint32(20);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b);
}

/** Opens a proof and returns the bytes after its label. Throws when it does not verify. */
function openProof(proof: string, label: Uint8Array, theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  const plaintext = decryptBinary(fromBase64(proof), theirPublicKey, mySecretKey);
  if (plaintext.length < label.length || !bytesEqual(plaintext.subarray(0, label.length), label)) {
    throw new Error("Session proof has the wrong label");
  }
  return plaintext.subarray(label.length);
}

/** The session field of a handshake message, or null when it has none this side speaks. */
function sessionFields(message: Record<string, unknown>): SessionFields | null {
  const session = message.session;
  if (!isRecord(session) || session.v !== SESSION_KEY_VERSION) return null;
  if (typeof session.key !== "string" || typeof session.proof !== "string") {
    throw new Error("Malformed session offer");
  }
  if (fromBase64(session.key).length !== KEY_LENGTH) throw new Error("Invalid session key");
  return { v: session.v, key: session.key, proof: session.proof };
}

export interface KeyExchangeResult {
  peerPublicKey: Uint8Array;
  peerPublicKeyBase64: string;
  channel: PeerChannel;
  /** Fields to add to the plaintext key_exchange_ack. */
  ack: { session?: SessionFields };
}

/**
 * The responder's half: reads a key_exchange and answers it. Throws on a
 * malformed exchange or a bad proof, and SessionKeyRequiredError when a key
 * that has used session keys before arrives without one.
 */
export function acceptKeyExchange(
  message: Record<string, unknown>,
  keyPair: KeyPair,
  sessionKeyedPeers: SessionKeyedPeers,
): KeyExchangeResult {
  if (typeof message.pubkey !== "string" || !message.pubkey) throw new Error("Missing key exchange public key");
  const peerPublicKey = fromBase64(message.pubkey);
  if (peerPublicKey.length !== KEY_LENGTH) throw new Error("Invalid key exchange public key");
  const peerPublicKeyBase64 = toBase64(peerPublicKey);

  const offer = sessionFields(message);
  if (!offer) {
    if (sessionKeyedPeers.has(peerPublicKeyBase64)) throw new SessionKeyRequiredError();
    return { peerPublicKey, peerPublicKeyBase64, channel: PeerChannel.legacy(peerPublicKey, keyPair.secretKey), ack: {} };
  }

  const offerKey = fromBase64(offer.key);
  if (!bytesEqual(openProof(offer.proof, OFFER_LABEL, peerPublicKey, keyPair.secretKey), offerKey)) {
    throw new Error("Session proof does not match its key");
  }
  sessionKeyedPeers.add(peerPublicKeyBase64);
  const ephemeral = nacl.box.keyPair();
  const proof = encryptBinary(concatBytes(ANSWER_LABEL, ephemeral.publicKey, offerKey), peerPublicKey, keyPair.secretKey);
  return {
    peerPublicKey,
    peerPublicKeyBase64,
    channel: PeerChannel.session(nacl.box.before(offerKey, ephemeral.secretKey), "responder"),
    ack: { session: { v: SESSION_KEY_VERSION, key: toBase64(ephemeral.publicKey), proof: toBase64(proof) } },
  };
}

/** The initiator's half: one offer per connection attempt. */
export class SessionOffer {
  private readonly ephemeral = nacl.box.keyPair();
  private readonly theirKeyBase64: string;

  constructor(private readonly keyPair: KeyPair, private readonly theirPublicKey: Uint8Array) {
    this.theirKeyBase64 = toBase64(theirPublicKey);
  }

  /** The key_exchange message to send in plaintext. */
  message(): { type: "key_exchange"; pubkey: string; session: SessionFields } {
    const proof = encryptBinary(concatBytes(OFFER_LABEL, this.ephemeral.publicKey), this.theirPublicKey, this.keyPair.secretKey);
    return {
      type: "key_exchange",
      pubkey: toBase64(this.keyPair.publicKey),
      session: { v: SESSION_KEY_VERSION, key: toBase64(this.ephemeral.publicKey), proof: toBase64(proof) },
    };
  }

  /**
   * Reads the key_exchange_ack. An ack without a session means the responder
   * predates session keys, which is refused once it has answered with one.
   */
  accept(ack: Record<string, unknown>, sessionKeyedPeers: SessionKeyedPeers): PeerChannel {
    const answer = sessionFields(ack);
    if (!answer) {
      if (sessionKeyedPeers.has(this.theirKeyBase64)) throw new SessionKeyRequiredError();
      return PeerChannel.legacy(this.theirPublicKey, this.keyPair.secretKey);
    }
    const answerKey = fromBase64(answer.key);
    const sealed = openProof(answer.proof, ANSWER_LABEL, this.theirPublicKey, this.keyPair.secretKey);
    if (!bytesEqual(sealed, concatBytes(answerKey, this.ephemeral.publicKey))) {
      throw new Error("Session proof does not match this offer");
    }
    sessionKeyedPeers.add(this.theirKeyBase64);
    return PeerChannel.session(nacl.box.before(answerKey, this.ephemeral.secretKey), "initiator");
  }
}

/**
 * Whether a capability message says its sender speaks session keys while it
 * arrived over the static box. That means someone stripped the session field
 * off the handshake, since both sides would otherwise have used it.
 */
export function isSessionKeyDowngrade(message: unknown, channel: PeerChannel): boolean {
  if (channel.sessionKeyed || !isRecord(message)) return false;
  const version = message.sessionKeyVersion;
  return typeof version === "number" && version >= SESSION_KEY_VERSION;
}
