import { createHash } from "crypto";
import * as nacl from "tweetnacl";

/**
 * Keys for one project board, all derived from the 32-byte board secret the
 * app grants (docs/project-boards.md, "Keys"). The relay only ever sees
 * boardId and signatures; boardKey never leaves this computer.
 */
export interface BoardKeys {
  /** NaCl secretbox key for every record. */
  boardKey: Uint8Array;
  /** Ed25519 key pair that signs relay requests. */
  signing: nacl.SignKeyPair;
  /** The Ed25519 public key in unpadded base64url, 43 characters. */
  boardId: string;
  /** X25519 secret key that opens intake boxes ("Intake from outside services"). */
  boxSecret: Uint8Array;
  /** Its public key, which intake tokens carry so services can seal items to the board. */
  boxKey: Uint8Array;
}

const KEY_LABEL = "socketagent-board-key-v1";
const AUTH_LABEL = "socketagent-board-auth-v1";
const BOX_LABEL = "socketagent-board-box-v1";
const REQUEST_CONTEXT = "socketagent-board-v1";

/** Decodes a standard padded base64 board secret. Null unless it is exactly 32 bytes. */
export function decodeBoardSecret(secret: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) return null;
  const bytes = Buffer.from(secret, "base64");
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

function labelledHash(label: string, secret: Uint8Array): Uint8Array {
  const digest = createHash("sha512").update(Buffer.from(label, "utf8")).update(secret).digest();
  return new Uint8Array(digest.subarray(0, 32));
}

/** Derives boardKey, the signing key and boardId from a decoded secret. */
export function deriveBoardKeys(secret: Uint8Array): BoardKeys {
  const signing = nacl.sign.keyPair.fromSeed(labelledHash(AUTH_LABEL, secret));
  const box = nacl.box.keyPair.fromSecretKey(labelledHash(BOX_LABEL, secret));
  return {
    boardKey: labelledHash(KEY_LABEL, secret),
    signing,
    boardId: Buffer.from(signing.publicKey).toString("base64url"),
    boxSecret: box.secretKey,
    boxKey: box.publicKey,
  };
}

/** Bytes a sealed record takes on the relay for [plaintext]: nonce, MAC and the text. */
export function sealedRecordBytes(plaintext: string): number {
  return nacl.secretbox.nonceLength + nacl.secretbox.overheadLength + Buffer.byteLength(plaintext, "utf8");
}

/** Standard padded base64 of nonce || secretbox(plaintext), the vault's record format. */
export function sealBoardRecord(boardKey: Uint8Array, plaintext: string): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(new Uint8Array(Buffer.from(plaintext, "utf8")), nonce, boardKey);
  return Buffer.concat([nonce, box]).toString("base64");
}

/** Opens a sealed record. Null when it is malformed or sealed with another key. */
export function openBoardRecord(boardKey: Uint8Array, sealed: string): string | null {
  const bytes = new Uint8Array(Buffer.from(sealed, "base64"));
  if (bytes.length < nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) return null;
  const opened = nacl.secretbox.open(
    bytes.subarray(nacl.secretbox.nonceLength),
    bytes.subarray(0, nacl.secretbox.nonceLength),
    boardKey,
  );
  return opened ? Buffer.from(opened).toString("utf8") : null;
}

/**
 * Opens an intake box, base64 of ephemeralPublic(32) || nonce(24) ||
 * nacl.box(json, nonce, boxKey, ephemeralSecret). Null when it is malformed
 * or sealed to another board.
 */
export function openIntakeBox(boxSecret: Uint8Array, sealed: string): string | null {
  const bytes = new Uint8Array(Buffer.from(sealed, "base64"));
  const keyEnd = nacl.box.publicKeyLength;
  const nonceEnd = keyEnd + nacl.box.nonceLength;
  if (bytes.length < nonceEnd + nacl.box.overheadLength) return null;
  const opened = nacl.box.open(
    bytes.subarray(nonceEnd),
    bytes.subarray(keyEnd, nonceEnd),
    bytes.subarray(0, keyEnd),
    boxSecret,
  );
  return opened ? Buffer.from(opened).toString("utf8") : null;
}

/** The X-SA-* headers for one relay request. [path] has no query string. */
export function signBoardRequest(
  keys: BoardKeys,
  method: string,
  path: string,
  time: number,
  body: Uint8Array,
): Record<string, string> {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = [REQUEST_CONTEXT, method, path, String(time), bodyHash].join("\n");
  const signature = nacl.sign.detached(new Uint8Array(Buffer.from(message, "utf8")), keys.signing.secretKey);
  return {
    "X-SA-Board": keys.boardId,
    "X-SA-Time": String(time),
    "X-SA-Signature": Buffer.from(signature).toString("base64"),
  };
}
