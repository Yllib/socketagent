const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const nacl = require("tweetnacl");
const {
  decodeBoardSecret,
  deriveBoardKeys,
  openBoardRecord,
  openIntakeBox,
  sealBoardRecord,
  signBoardRequest,
} = require("#server/project-board-crypto");

// Secret bytes 00..1f. The relay and the app pin the same board ID.
const SECRET = Buffer.from([...Array(32).keys()]).toString("base64");
const BOARD_ID = "wss17kbg38xaAvyhI4f73jAG7PdZhHkbrL0YmbFGB6M";
const BOX_KEY = "WDsQKhlzBPFxuJUyvZNk5QQj6x3oHsWKE05v+2bkaUA=";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** @param {string} label @param {Uint8Array} secret */
function labelled(label, secret) {
  return crypto.createHash("sha512").update(Buffer.concat([Buffer.from(label, "utf8"), secret])).digest().subarray(0, 32);
}

function keys() {
  const secret = decodeBoardSecret(SECRET);
  assert.ok(secret);
  return { secret, keys: deriveBoardKeys(secret) };
}

test("board ID matches the relay and app test vector", () => {
  assert.equal(keys().keys.boardId, BOARD_ID);
});

test("derivations follow the doc, checked with Node's own Ed25519", () => {
  const { secret, keys: derived } = keys();
  assert.deepEqual(Buffer.from(derived.boardKey), labelled("socketagent-board-key-v1", secret));
  const seed = labelled("socketagent-board-auth-v1", secret);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  assert.equal(jwk.x, derived.boardId);
  assert.equal(derived.boardId.length, 43);
});

test("a sealed record is base64 of nonce || secretbox(plaintext)", () => {
  const { keys: derived } = keys();
  const plaintext = JSON.stringify({ v: 1, id: "c_0123456789ab", title: "Ship 1.4" });
  const sealed = sealBoardRecord(derived.boardKey, plaintext);
  const bytes = new Uint8Array(Buffer.from(sealed, "base64"));
  assert.equal(Buffer.from(bytes).toString("base64"), sealed, "standard padded base64");
  const opened = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), derived.boardKey);
  assert.ok(opened);
  assert.equal(Buffer.from(opened).toString("utf8"), plaintext);
  assert.equal(openBoardRecord(derived.boardKey, sealed), plaintext);
  assert.equal(openBoardRecord(new Uint8Array(32), sealed), null, "another key cannot open it");
});

test("request signatures cover context, method, path, time and the body hash", () => {
  const { keys: derived } = keys();
  const body = Buffer.from(JSON.stringify({ expectedVersion: 0, ciphertext: "AAAA" }));
  const headers = signBoardRequest(derived, "PUT", "/api/board/records/card.c_1", 1_700_000_000_000, body);
  assert.equal(headers["X-SA-Board"], BOARD_ID);
  assert.equal(headers["X-SA-Time"], "1700000000000");
  const message = [
    "socketagent-board-v1", "PUT", "/api/board/records/card.c_1", "1700000000000",
    crypto.createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  const publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: BOARD_ID }, format: "jwk" });
  const signature = Buffer.from(headers["X-SA-Signature"], "base64");
  assert.equal(signature.length, 64);
  assert.ok(crypto.verify(null, Buffer.from(message), publicKey, signature));
  assert.ok(!crypto.verify(null, Buffer.from(message + "\n"), publicKey, signature), "no trailing newline");
});

test("the box key matches the app's test vector and Node's own X25519", () => {
  const { secret, keys: derived } = keys();
  assert.equal(Buffer.from(derived.boxKey).toString("base64"), BOX_KEY);
  const boxSecret = labelled("socketagent-board-box-v1", secret);
  assert.deepEqual(Buffer.from(derived.boxSecret), boxSecret, "used directly as the X25519 secret key");
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, boxSecret]), format: "der", type: "pkcs8" });
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  assert.equal(Buffer.from(String(jwk.x), "base64url").toString("base64"), BOX_KEY);
});

test("an intake box sealed the way a service does it opens with the board secret", () => {
  const { keys: derived } = keys();
  // The service knows only boxKey, from the intake token.
  const boxKey = new Uint8Array(Buffer.from(BOX_KEY, "base64"));
  const item = JSON.stringify({ v: 1, source: "Feedback Hub", ref: "marina#123", event: "opened", title: "Crash on launch" });
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(new Uint8Array(Buffer.from(item, "utf8")), nonce, boxKey, ephemeral.secretKey);
  const sealed = Buffer.concat([ephemeral.publicKey, nonce, box]).toString("base64");
  assert.equal(openIntakeBox(derived.boxSecret, sealed), item);

  const other = deriveBoardKeys(new Uint8Array(32).fill(7));
  assert.equal(openIntakeBox(other.boxSecret, sealed), null, "another board cannot open it");
  assert.equal(openIntakeBox(derived.boxSecret, sealed.slice(0, 40)), null, "a truncated box");
  assert.equal(openIntakeBox(derived.boxSecret, sealBoardRecord(derived.boardKey, item)), null, "a secretbox record is not an intake box");
});

test("only a padded base64 secret of exactly 32 bytes is accepted", () => {
  assert.ok(decodeBoardSecret(SECRET));
  assert.equal(decodeBoardSecret(SECRET.replace(/=$/, "")), null);
  assert.equal(decodeBoardSecret(Buffer.alloc(31).toString("base64")), null);
  assert.equal(decodeBoardSecret(Buffer.alloc(33).toString("base64")), null);
  assert.equal(decodeBoardSecret(Buffer.alloc(32, 0xfb).toString("base64url") + "="), null);
});
