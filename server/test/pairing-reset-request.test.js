const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const dataDir = require("./test-data-dir");

const {
  MAX_RESET_CHALLENGES,
  PairingResetGate,
  RESET_CHALLENGE_LIFETIME_MS,
  RESET_CHALLENGE_PATH,
  RESET_PATH,
  answerPairingResetRequest,
  requestPairingReset,
} = require("#server/pairing-reset-request");
const { isRecord, parseJsonObject } = require("#server/value-guards");

// `socketagent pair --reset` and the running server prove AUTH_TOKEN to each
// other before the reset. The token never goes on the wire, and the script
// reports a reset only when the server that holds the token confirmed it.

const scripts = path.join(__dirname, "..", "scripts");
const newToken = () => crypto.randomBytes(32).toString("hex");
const nonce = () => crypto.randomBytes(32).toString("hex");

/**
 * A loopback listener, closed when the test ends.
 * @param {import("node:test").TestContext} t
 * @param {http.RequestListener} onRequest
 */
async function listen(t, onRequest) {
  const server = http.createServer(onRequest);
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

/** A listener that holds the port without the token and says yes to everything. It keeps what it was sent. */
async function impostor(/** @type {import("node:test").TestContext} */ t) {
  /** @type {string[]} */
  const seen = [];
  const port = await listen(t, (req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (/** @type {Buffer} */ chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)} ${Buffer.concat(chunks).toString("utf8")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ serverNonce: nonce(), proof: nonce(), done: nonce() }));
    });
  });
  return { port, seen };
}

test("the script and the server prove the token to each other, and the reset runs once", async (t) => {
  let token = newToken();
  const tokenBefore = token;
  let resets = 0;
  const gate = new PairingResetGate(() => token);
  // The reset makes a new AUTH_TOKEN, as the real one does.
  const startOver = () => { resets++; token = newToken(); };
  /** @type {string[]} */
  const bodies = [];
  const port = await listen(t, (req, res) => {
    req.on("data", (/** @type {Buffer} */ chunk) => bodies.push(chunk.toString("utf8")));
    if (!answerPairingResetRequest(req, res, gate, startOver)) { res.writeHead(404); res.end(); }
  });

  assert.equal(await requestPairingReset(port, tokenBefore), "done");
  assert.equal(resets, 1);
  assert.equal(bodies.length, 2);
  assert.equal(bodies.some((body) => body.includes(tokenBefore)), false, "the token is never sent");

  // The reset request, sent again as it was, does nothing.
  const replay = await fetch(`http://127.0.0.1:${port}${RESET_PATH}`, { method: "POST", body: bodies[1] });
  assert.equal(replay.status, 401);
  assert.equal(resets, 1);

  // Someone who holds another token is told nothing was changed.
  await assert.rejects(requestPairingReset(port, newToken()), /did not prove/);
  assert.equal(resets, 1);
});

test("a listener that does not hold the token is sent nothing it can use and gets no reset reported", async (t) => {
  const token = newToken();
  const { port, seen } = await impostor(t);

  await assert.rejects(requestPairingReset(port, token), /did not prove it is this install's SocketAgent server\. Nothing was changed/);
  assert.equal(seen.length, 1, "the script stops after the challenge");
  assert.match(seen[0], new RegExp(`^POST ${RESET_CHALLENGE_PATH} `));
  assert.equal(seen[0].includes(token), false);
  assert.equal(seen[0].includes("authorization"), false);
});

test("nothing listening means no server, so the caller may write the files", async () => {
  // A port that was just free: a listener is opened on it and closed again.
  const closed = http.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const address = closed.address();
  assert.ok(address && typeof address !== "string");
  closed.close();
  await once(closed, "close");
  assert.equal(await requestPairingReset(address.port, newToken()), "no-server");
});

test("a reset needs the right proof for a challenge that is open, unspent and under 30 seconds old", () => {
  const token = newToken();
  let now = 1_000_000;
  let resets = 0;
  const gate = new PairingResetGate(() => token, () => now);
  const startOver = () => { resets++; };
  /** The proof a holder of `key` would send for a challenge. */
  const proofFor = (/** @type {string} */ key, /** @type {string} */ clientNonce, /** @type {string} */ serverNonce) =>
    crypto.createHmac("sha256", key).update(`socketagent-pairing-reset-v1\0reset\0${clientNonce}\0${serverNonce}`).digest("hex");
  const open = () => {
    const clientNonce = nonce();
    const challenge = gate.challenge({ clientNonce });
    assert.ok(challenge);
    return { clientNonce, ...challenge };
  };

  assert.equal(gate.challenge({ clientNonce: "short" }), null);
  assert.equal(gate.challenge(undefined), null);
  assert.equal(gate.reset({ serverNonce: nonce(), proof: nonce() }, startOver), null, "no such challenge");

  // The server's own proof is not accepted back as the reset proof.
  const mirrored = open();
  assert.equal(gate.reset({ serverNonce: mirrored.serverNonce, proof: mirrored.proof }, startOver), null);

  // A wrong proof spends the challenge, so the right one after it is refused too.
  const guessed = open();
  assert.equal(gate.reset({ serverNonce: guessed.serverNonce, proof: proofFor(newToken(), guessed.clientNonce, guessed.serverNonce) }, startOver), null);
  assert.equal(gate.reset({ serverNonce: guessed.serverNonce, proof: proofFor(token, guessed.clientNonce, guessed.serverNonce) }, startOver), null);

  const late = open();
  now += RESET_CHALLENGE_LIFETIME_MS;
  assert.equal(gate.reset({ serverNonce: late.serverNonce, proof: proofFor(token, late.clientNonce, late.serverNonce) }, startOver), null);
  assert.equal(resets, 0);

  // Only so many challenges are kept. The oldest gives way.
  const first = open();
  const rest = Array.from({ length: MAX_RESET_CHALLENGES }, open);
  assert.equal(gate.reset({ serverNonce: first.serverNonce, proof: proofFor(token, first.clientNonce, first.serverNonce) }, startOver), null);
  const last = rest[rest.length - 1];
  const receipt = gate.reset({ serverNonce: last.serverNonce, proof: proofFor(token, last.clientNonce, last.serverNonce) }, startOver);
  assert.ok(receipt);
  assert.equal(resets, 1);
  assert.equal(gate.reset({ serverNonce: last.serverNonce, proof: proofFor(token, last.clientNonce, last.serverNonce) }, startOver), null, "one reset per challenge");
  assert.equal(resets, 1);
});

test("show-pairing --reset changes nothing and reports no reset when something else holds the port", async (t) => {
  const { port, seen } = await impostor(t);
  const folder = path.join(dataDir, "reset-impostor");
  fs.mkdirSync(folder);
  const envFile = path.join(folder, ".env");
  const keysFile = path.join(folder, "relay-keys.json");
  const env = { PATH: process.env.PATH ?? "", HOME: folder, SOCKETAGENT_ENV: envFile, SOCKETAGENT_KEYS_FILE: keysFile, SOCKET_AGENT_DATA_DIR: folder };
  execFileSync(process.execPath, [path.join(scripts, "setup.js"), "--envfile", envFile, "--keysfile", keysFile, "--relay-url", "wss://relay.example.test", "--port", String(port)], { env, stdio: "ignore" });
  const envBefore = fs.readFileSync(envFile, "utf8");
  const stateBefore = fs.readFileSync(path.join(folder, "transport.json"), "utf8");
  const token = envBefore.match(/^AUTH_TOKEN=(.*)$/m)?.[1] ?? "";
  assert.match(token, /^[0-9a-f]{64}$/);

  const run = promisify(execFile)(process.execPath, [path.join(scripts, "show-pairing.js"), "--reset", "--raw"], { env });
  await assert.rejects(run, (/** @type {unknown} */ error) => {
    assert.ok(isRecord(error));
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "", "no pairing code is printed");
    assert.match(String(error.stderr), /Nothing was changed/);
    assert.doesNotMatch(String(error.stderr), /Pairing started over/);
    return true;
  });
  assert.equal(fs.readFileSync(envFile, "utf8"), envBefore);
  assert.equal(fs.readFileSync(path.join(folder, "transport.json"), "utf8"), stateBefore);
  assert.equal(seen.length, 1);
  assert.equal(seen.some((request) => request.includes(token)), false, "the listener never saw AUTH_TOKEN");
  assert.deepEqual(Object.keys(parseJsonObject(seen[0].slice(seen[0].lastIndexOf("{")))), ["clientNonce"]);
});
