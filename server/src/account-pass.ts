import * as nacl from "tweetnacl";
import { isValidPublicKey, normalizePublicKey } from "./device-registry";
import { isRecord } from "./value-guards";

/**
 * Device passes. Every device signed in to an account can sign with the
 * account's pass key, an Ed25519 key derived from the master key. A pass is
 * that key's signature over one device's X25519 public key, so it says "this
 * device is on my account". It is not a secret: it only helps the device
 * whose key the handshake proved.
 *
 * Wire form: `{k: <pass key, base64>, s: <signature, base64>}`. The signed
 * bytes are the UTF-8 context, one zero byte, then the 32-byte device key.
 */
export const DEVICE_PASS_CONTEXT = "socketagent-device-pass-v1";

/** The bytes a pass for [devicePublicKey] signs. */
export function devicePassMessage(devicePublicKey: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(DEVICE_PASS_CONTEXT, "utf8"), Buffer.from([0]), Buffer.from(devicePublicKey)]);
}

/**
 * The y coordinates of the Ed25519 points of small order, as 32 bytes in hex,
 * little endian: 0, 1, the two of order 8, p - 1, and the non-canonical p and
 * p + 1. libsodium rejects the same table. The top bit of the last byte is
 * the sign of x and is masked off before comparing.
 */
const SMALL_ORDER_Y = new Set([
  "00".repeat(32),
  `01${"00".repeat(31)}`,
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  `ec${"ff".repeat(30)}7f`,
  `ed${"ff".repeat(30)}7f`,
  `ee${"ff".repeat(30)}7f`,
]);

/**
 * Whether a 32-byte Ed25519 public key is a point of small order. For such a
 * key a signature can be made up without any private key, and tweetnacl
 * accepts it, so it must never count as an account's pass key.
 */
export function isSmallOrderKey(publicKey: Uint8Array): boolean {
  const y = Buffer.from(publicKey);
  y[31] &= 0x7f;
  return SMALL_ORDER_Y.has(y.toString("hex"));
}

/**
 * The pass key of [raw], canonical base64, when [raw] is a pass with a valid
 * signature over [devicePublicKey]. Null for anything else, a pass key of
 * small order included. Whether this computer trusts that pass key is the
 * caller's question.
 */
export function verifiedPassKey(raw: unknown, devicePublicKey: string): string | null {
  if (!isRecord(raw)) return null;
  const { k, s } = raw;
  if (!isValidPublicKey(k) || typeof s !== "string" || !isValidPublicKey(devicePublicKey)) return null;
  const passKey = Buffer.from(k, "base64");
  if (isSmallOrderKey(passKey)) return null;
  const signature = Buffer.from(s, "base64");
  if (signature.length !== nacl.sign.signatureLength) return null;
  const message = devicePassMessage(Buffer.from(devicePublicKey, "base64"));
  return nacl.sign.detached.verify(message, signature, passKey) ? normalizePublicKey(k) : null;
}

/**
 * The pass keys an `account_pass_key` message names as retired: every valid
 * key of [raw] in canonical base64, in the order sent. Nothing is cut off
 * here. The vault appends the newest key last, so a limit on the front of
 * the list would lose the one that matters. The registry caps what it keeps.
 */
export function retiredPassKeysOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter(isValidPublicKey).map(normalizePublicKey) : [];
}
