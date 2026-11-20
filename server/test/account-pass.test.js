const assert = require("node:assert/strict");
const test = require("node:test");

const nacl = require("tweetnacl");
const { devicePassMessage, isSmallOrderKey, verifiedPassKey } = require("#server/account-pass");

// Made by the app's AccountKeys from a master key of 32 0x01 bytes, for a
// device key of 32 0x02 bytes. The app's account_crypto_test has the same.
const DEVICE = Buffer.alloc(32, 2).toString("base64");
const PASS = {
  k: "hEoLS8SUHi9ndkDdfX3V71KZeJzAb59HeGoJPPkYBTo=",
  s: "cuNhFoI79bv+Dhg9YJZxujufs46RsJMh3pzJO+XyWWedRRYX3LpO0I6yrTkxLrzONr9SR1N5q6OxlsEUK39EDA==",
};

test("the app's pass verifies for its own device key and nothing else", () => {
  assert.equal(verifiedPassKey(PASS, DEVICE), PASS.k);
  assert.equal(verifiedPassKey(PASS, Buffer.alloc(32, 3).toString("base64")), null);
  const flipped = Buffer.from(PASS.s, "base64");
  flipped[0] ^= 1;
  assert.equal(verifiedPassKey({ ...PASS, s: flipped.toString("base64") }, DEVICE), null);
  assert.equal(verifiedPassKey({ k: PASS.k, s: PASS.s.slice(0, 40) }, DEVICE), null);
  assert.equal(verifiedPassKey({ k: "short", s: PASS.s }, DEVICE), null);
  assert.equal(verifiedPassKey("pass", DEVICE), null);
  assert.equal(verifiedPassKey(undefined, DEVICE), null);
});

const P = 2n ** 255n - 19n;

/** @param {bigint} base @param {bigint} exponent */
function powModP(base, exponent) {
  let result = 1n;
  for (let b = base % P, e = exponent; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) result = (result * b) % P;
  return result;
}

/**
 * Whether y is the y coordinate of a point of order 1, 2, 4 or 8, worked out
 * from the curve -x^2 + y^2 = 1 + d x^2 y^2 instead of from a table. Order 4
 * has y = 0. Doubling an order 8 point gives one of those, which needs
 * x^2 = -y^2, and the curve then says d y^4 + 2 y^2 - 1 = 0.
 * @param {bigint} y
 */
function smallOrderY(y) {
  const d = (P - 121665n) * powModP(121666n, P - 2n) % P;
  return y === 0n || y === 1n || y === P - 1n || (d * y ** 4n + 2n * y ** 2n + P - 1n) % P === 0n;
}

/** @param {bigint} y @param {boolean} sign */
function encodePoint(y, sign) {
  const bytes = Buffer.from(y.toString(16).padStart(64, "0"), "hex").reverse();
  if (sign) bytes[31] |= 0x80;
  return bytes;
}

test("pass keys of small order are refused", () => {
  // Every y below 2^255 that tweetnacl would read as one of the eight points.
  const order8 = [
    2707385501144840649318225287225658788936804267575313519463743609750303402022n,
    55188659117513257062467267217118295137698188065244968500265048394206261417927n,
  ];
  assert.equal(order8[0] + order8[1], P);
  const weak = [0n, 1n, P - 1n, ...order8];
  for (const y of weak) assert.equal(smallOrderY(y), true, `y = ${y} has small order`);
  const message = devicePassMessage(Buffer.from(DEVICE, "base64"));
  const signature = Buffer.from(nacl.sign.detached(message, nacl.sign.keyPair().secretKey)).toString("base64");
  for (const y of [...weak, P, P + 1n]) {
    for (const sign of [false, true]) {
      const key = encodePoint(y, sign);
      assert.equal(isSmallOrderKey(key), true, key.toString("hex"));
      assert.equal(verifiedPassKey({ k: key.toString("base64"), s: signature }, DEVICE), null);
    }
  }

  // Real keys are not caught, and the check leaves the caller's bytes alone.
  const real = Buffer.from(PASS.k, "base64");
  assert.equal(smallOrderY(BigInt(`0x${Buffer.from(real).reverse().toString("hex")}`) & (2n ** 255n - 1n)), false);
  assert.equal(isSmallOrderKey(real), false);
  const signed = encodePoint(0n, true);
  isSmallOrderKey(signed);
  assert.equal(signed[31], 0x80);
});
