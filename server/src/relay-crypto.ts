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

/** Encrypt a message string using NaCl box */
export function encrypt(
  message: string,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): EncryptedEnvelope {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(message);
  const ciphertext = nacl.box(messageBytes, nonce, theirPublicKey, mySecretKey);
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
  const plaintext = nacl.box.open(ciphertext, nonce, theirPublicKey, mySecretKey);
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
  const ciphertext = nacl.box(plaintext, nonce, theirPublicKey, mySecretKey);
  if (!ciphertext) throw new Error("Encryption failed");
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
}

/** Decrypt a packed binary envelope produced by encryptBinary. */
export function decryptBinary(
  envelope: Buffer | Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): Uint8Array {
  const buf = envelope instanceof Buffer ? envelope : Buffer.from(envelope);
  if (buf.length < nacl.box.nonceLength) throw new Error("Envelope too short");
  const nonce = new Uint8Array(buf.subarray(0, nacl.box.nonceLength));
  const ciphertext = new Uint8Array(buf.subarray(nacl.box.nonceLength));
  const plaintext = nacl.box.open(ciphertext, nonce, theirPublicKey, mySecretKey);
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
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
