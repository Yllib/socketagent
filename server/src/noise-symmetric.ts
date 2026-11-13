import * as crypto from "crypto";

/**
 * The building blocks every Noise_*_25519_ChaChaPoly_SHA256 handshake shares,
 * from the Noise Protocol Framework specification, revision 34: the DH, cipher
 * and hash functions (sections 4 and 12) and the SymmetricState object
 * (sections 5.1 and 5.2). Everything runs on Node's built-in crypto.
 *
 * Handshake code imports from here. Everything else imports the pattern
 * module, noise-ikpsk1.ts, and never this file.
 */

/** Length in bytes of an X25519 key, a DH result, a cipher key and a hash. */
export const NOISE_KEY_LENGTH = 32;
/** Length in bytes of the ChaCha20-Poly1305 tag on every ciphertext. */
export const NOISE_TAG_LENGTH = 16;

/**
 * Why a handshake step was refused:
 * - `malformed`: an input has the wrong length.
 * - `dh`: a public key is low order, so its DH result is all zero.
 * - `decrypt`: a ciphertext did not verify. The message was tampered with,
 *   or the two sides differ on a key, the prologue or the PSK.
 */
export type NoiseFailure = "malformed" | "dh" | "decrypt";

/** Every refusal in the handshake throws this. A peer that causes one gets no answer. */
export class NoiseError extends Error {
  constructor(readonly reason: NoiseFailure, message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

/** A raw X25519 key pair, the same shape as relay-crypto's KeyPair. */
export interface NoiseKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Throws `malformed` unless `bytes` is exactly `length` long. */
export function requireLength(name: string, bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) throw new NoiseError("malformed", `${name} must be ${length} bytes, got ${bytes.length}`);
}

// Node takes X25519 keys as DER, which for this curve is a fixed prefix
// followed by the 32 raw bytes (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyObject(secretKey: Uint8Array): crypto.KeyObject {
  requireLength("X25519 secret key", secretKey, NOISE_KEY_LENGTH);
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, secretKey]), format: "der", type: "pkcs8" });
}

function publicKeyObject(publicKey: Uint8Array): crypto.KeyObject {
  requireLength("X25519 public key", publicKey, NOISE_KEY_LENGTH);
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
}

/** The key pair for a raw 32-byte secret key. X25519 clamps the secret when it is used. */
export function keyPairFromSecretKey(secretKey: Uint8Array): NoiseKeyPair {
  const spki = crypto.createPublicKey(privateKeyObject(secretKey)).export({ format: "der", type: "spki" });
  return { publicKey: spki.subarray(SPKI_PREFIX.length), secretKey: Buffer.from(secretKey) };
}

/** A new random X25519 key pair. */
export function generateKeyPair(): NoiseKeyPair {
  return keyPairFromSecretKey(crypto.randomBytes(NOISE_KEY_LENGTH));
}

/**
 * Refuses the all-zero DH result that every low-order public key produces
 * (spec section 12.1). `dh` runs each result through this, so the refusal
 * does not depend on what the X25519 library does with such a key.
 */
export function refuseZeroDh(shared: Uint8Array): Uint8Array {
  requireLength("DH result", shared, NOISE_KEY_LENGTH);
  let bits = 0;
  for (const byte of shared) bits |= byte;
  if (bits === 0) throw new NoiseError("dh", "Diffie-Hellman result is all zero");
  return shared;
}

/** X25519 of our secret key and their public key. Throws `dh` for a low-order public key. */
export function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const privateKey = privateKeyObject(secretKey);
  const peerKey = publicKeyObject(publicKey);
  let shared: Buffer;
  try {
    shared = crypto.diffieHellman({ privateKey, publicKey: peerKey });
  } catch {
    // OpenSSL fails the derivation itself when the result would be all zero.
    throw new NoiseError("dh", "Diffie-Hellman refused the public key");
  }
  return refuseZeroDh(shared);
}

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const hmac = crypto.createHmac("sha256", key);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

/**
 * HKDF from spec section 4.3. It always works out three outputs. Callers that
 * need two ignore the third, which costs one extra HMAC.
 */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Buffer, Buffer, Buffer] {
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial);
  const output1 = hmacSha256(tempKey, Uint8Array.of(1));
  const output2 = hmacSha256(tempKey, output1, Uint8Array.of(2));
  const output3 = hmacSha256(tempKey, output2, Uint8Array.of(3));
  return [output1, output2, output3];
}

/** The ChaChaPoly nonce: 32 zero bits, then the counter as 64 bits little-endian. */
function nonceBytes(counter: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(BigInt(counter), 4);
  return nonce;
}

/**
 * The SymmetricState of spec section 5.2, with its CipherState folded in: the
 * chaining key `ck`, the handshake hash `h`, and the cipher key `k` with its
 * nonce counter `n`. A handshake pattern drives it one token at a time.
 *
 * One difference from the spec: with no key set, the spec's EncryptAndHash
 * passes plaintext through. IKpsk1 mixes a key in before it seals anything,
 * so here that case throws instead of emitting or accepting plaintext.
 */
export class SymmetricState {
  private constructor(
    private ck: Buffer,
    private h: Buffer,
    private k: Buffer | null,
    private n: number,
  ) {}

  /** InitializeSymmetric: `h` is the protocol name, hashed when it is longer than a hash. */
  static initialize(protocolName: string): SymmetricState {
    const name = Buffer.from(protocolName, "ascii");
    const h = name.length <= NOISE_KEY_LENGTH ? Buffer.concat([name], NOISE_KEY_LENGTH) : sha256(name);
    return new SymmetricState(h, h, null, 0);
  }

  /** An independent copy, so one message can be tried against several candidate inputs. */
  clone(): SymmetricState {
    return new SymmetricState(this.ck, this.h, this.k, this.n);
  }

  /** The handshake hash so far. After the last message it is the channel binding value. */
  get handshakeHash(): Uint8Array {
    return Buffer.from(this.h);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(this.h, data);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, key] = hkdf(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.k = key;
    this.n = 0;
  }

  /** Used for the `psk` token: mixes into the hash as well as the key. */
  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [ck, tempHash, key] = hkdf(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.mixHash(tempHash);
    this.k = key;
    this.n = 0;
  }

  private key(): Buffer {
    if (!this.k) throw new Error("Noise cipher used before a key was mixed in");
    return this.k;
  }

  /** Seals `plaintext` with the hash so far as associated data. Returns ciphertext then tag. */
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const cipher = crypto.createCipheriv("chacha20-poly1305", this.key(), nonceBytes(this.n), { authTagLength: NOISE_TAG_LENGTH });
    cipher.setAAD(this.h, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.n++;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  /** Opens what encryptAndHash sealed. Throws `decrypt` and leaves the state unchanged when it does not verify. */
  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length < NOISE_TAG_LENGTH) throw new NoiseError("malformed", "Ciphertext is shorter than its tag");
    const tagStart = ciphertext.length - NOISE_TAG_LENGTH;
    const decipher = crypto.createDecipheriv("chacha20-poly1305", this.key(), nonceBytes(this.n), { authTagLength: NOISE_TAG_LENGTH });
    decipher.setAAD(this.h, { plaintextLength: tagStart });
    decipher.setAuthTag(ciphertext.subarray(tagStart));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, tagStart)), decipher.final()]);
    } catch {
      throw new NoiseError("decrypt", "Handshake ciphertext did not verify");
    }
    this.n++;
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Split: the two transport keys. The initiator sends with the first and the responder with the second. */
  split(): [Uint8Array, Uint8Array] {
    const [first, second] = hkdf(this.ck, new Uint8Array(0));
    return [first, second];
  }
}
