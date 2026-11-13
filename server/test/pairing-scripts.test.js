const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { pairingCode, relayUrlForCode } = require("../scripts/pairing-code");
const { isRecord, parseJsonObject, unknownArray } = require("#server/value-guards");

// The pairing code of wire spec section 6 and the scripts that print it,
// run against a throwaway install folder with a clean environment.

const scripts = path.join(__dirname, "..", "scripts");
let counter = 0;

/** A throwaway install: its own .env, key file and state, and a port nothing listens on. */
function install() {
  const folder = path.join(dataDir, `install-${++counter}`);
  fs.mkdirSync(folder);
  const envFile = path.join(folder, ".env");
  const keysFile = path.join(folder, "relay-keys.json");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: folder,
    SOCKETAGENT_ENV: envFile,
    SOCKETAGENT_KEYS_FILE: keysFile,
    SOCKET_AGENT_DATA_DIR: folder,
  };
  /** @param {string} script @param {string[]} args */
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(scripts, script), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  /** The code is the last line the script prints. */
  const lastLine = (/** @type {string} */ output) => output.trim().split("\n").at(-1) ?? "";
  return {
    folder,
    envFile,
    setup: () => lastLine(run("setup.js", "--envfile", envFile, "--keysfile", keysFile, "--relay-url", "wss://relay.example.test", "--port", "1")),
    /** @param {string[]} args */
    showPairing: (...args) => lastLine(run("show-pairing.js", "--raw", ...args)),
    state: () => parseJsonObject(fs.readFileSync(path.join(folder, "transport.json"), "utf8")),
    envValue: (/** @type {string} */ name) => fs.readFileSync(envFile, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "",
  };
}

/** @param {Record<string, unknown>} state */
function currentSecret(state) {
  const [current] = unknownArray(state.secrets).filter(isRecord);
  return String(current.secret);
}

test("an SA3 code has six parts, or seven when the relay is not the default", () => {
  const parts = { roomId: "ab".repeat(32), publicKey: "KEY=", secret: "SECRET=", port: 8085, hosts: ["192.168.1.20", "10.0.0.4"] };
  assert.equal(pairingCode(parts), `SA3|${"ab".repeat(32)}|KEY=|SECRET=|8085|192.168.1.20,10.0.0.4`);
  assert.equal(pairingCode({ ...parts, hosts: [], relayUrl: "wss://relay.example.test" }), `SA3|${"ab".repeat(32)}|KEY=|SECRET=|8085||wss://relay.example.test`);

  assert.equal(relayUrlForCode({ RELAY_URL: "wss://relay.jarofdirt.info" }), "");
  assert.equal(relayUrlForCode({ RELAY_URL: "wss://relay.jarofdirt.info/" }), "");
  assert.equal(relayUrlForCode({ RELAY_URL: "wss://relay.example.test/" }), "wss://relay.example.test");
  // The seventh part must start with wss://, so anything else is left out.
  assert.equal(relayUrlForCode({ RELAY_URL: "ws://192.168.1.9:8087" }), "");
  assert.equal(relayUrlForCode({}), "");
  // A computer that reaches its relay on localhost names the public address.
  assert.equal(relayUrlForCode({ RELAY_URL: "ws://localhost:8087", PUBLIC_RELAY_URL: "wss://relay.example.test" }), "wss://relay.example.test");
  assert.equal(relayUrlForCode({ RELAY_URL: "ws://127.0.0.1:8087" }), "");
});

test("setup prints an SA3 code for a new install and the same code when run again", () => {
  const computer = install();
  const code = computer.setup();
  const parts = code.split("|");
  assert.equal(parts.length, 7);
  assert.equal(parts[0], "SA3");
  assert.match(parts[1], /^[0-9a-f]{64}$/);
  assert.equal(parts[1], computer.envValue("PAIRING_TOKEN"));
  assert.equal(Buffer.from(parts[2], "base64").length, 32);
  assert.equal(parts[3], currentSecret(computer.state()));
  assert.equal(parts[4], "1");
  assert.equal(parts[6], "wss://relay.example.test");
  assert.equal(code.includes(computer.envValue("AUTH_TOKEN")), false, "AUTH_TOKEN is not in the code");

  assert.equal(computer.setup(), code);
  assert.equal(computer.showPairing(), code);
});

test("setup on an updated computer keeps its room ID and carries devices.json over", () => {
  const computer = install();
  fs.writeFileSync(computer.envFile, "PORT=1\nAUTH_TOKEN=old-token\nPAIRING_TOKEN=3f2a9c1e-old-room-id\nRELAY_URL=wss://relay.example.test\n");
  fs.writeFileSync(path.join(computer.folder, "devices.json"), JSON.stringify({
    version: 1, mode: "enforced", revoked: ["removed-key"],
    devices: [{ publicKey: "phone-key", kind: "device", name: "Pixel", platform: "android", addedAt: "2026-10-01", lastSeenAt: "2026-10-01", via: "token" }],
  }));
  const parts = computer.setup().split("|");
  assert.equal(parts[1], "3f2a9c1e-old-room-id");
  const state = computer.state();
  assert.equal(state.locked, true);
  assert.deepEqual(state.removed, ["removed-key"]);
  assert.deepEqual(unknownArray(state.devices).filter(isRecord).map((device) => [device.publicKey, device.transport]), [["phone-key", 1]]);
});

test("a new room ID for a computer that was already set up starts pairing over", () => {
  const computer = install();
  const first = computer.setup().split("|");
  // The installer's reset-pairing option removes the room ID and runs setup again.
  fs.writeFileSync(computer.envFile, fs.readFileSync(computer.envFile, "utf8").replace(/^PAIRING_TOKEN=.*\n/m, ""));
  const second = computer.setup().split("|");
  assert.notEqual(second[1], first[1]);
  assert.notEqual(second[3], first[3]);
  assert.equal(second[2], first[2], "the computer's key stays");
  assert.equal(unknownArray(computer.state().secrets).length, 1);
});

test("show-pairing --reset with no server running starts over in the files", () => {
  const computer = install();
  const first = computer.setup().split("|");
  assert.equal(computer.envValue("PORT"), "1", "the reset must only ever ask this install's own port");
  fs.appendFileSync(computer.envFile, `LINK_ROOM_TOKEN=${"cd".repeat(32)}\n`);
  const state = computer.state();
  fs.writeFileSync(path.join(computer.folder, "transport.json"), JSON.stringify({ ...state, locked: true, removed: ["removed-key"] }));

  const second = computer.showPairing("--reset").split("|");
  assert.notEqual(second[1], first[1]);
  assert.match(second[1], /^[0-9a-f]{64}$/);
  assert.notEqual(second[3], first[3]);
  assert.equal(computer.envValue("PAIRING_TOKEN"), second[1]);
  const after = computer.state();
  assert.equal(after.locked, false);
  assert.deepEqual(after.removed, ["removed-key"], "the removed list stays");
  assert.equal(after.relayKey, state.relayKey);
  assert.equal(computer.envValue("LINK_ROOM_TOKEN"), "cd".repeat(32), "the link room stays while the owner key does");
  assert.equal(computer.showPairing(), second.join("|"));

  // It is the way out of a damaged state file too.
  fs.writeFileSync(path.join(computer.folder, "transport.json"), "{ damaged");
  assert.throws(() => computer.showPairing(), /pair --reset/);
  const third = computer.showPairing("--reset").split("|");
  assert.equal(third[0], "SA3");
  assert.equal(fs.existsSync(path.join(computer.folder, "transport.json.unreadable")), true);
  // The owner key is new, so the relay would refuse the old link room. The server makes a new ID at its next start.
  assert.notEqual(computer.state().relayKey, state.relayKey);
  assert.equal(computer.envValue("LINK_ROOM_TOKEN"), "");
});
