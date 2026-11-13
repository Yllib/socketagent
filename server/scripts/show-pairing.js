#!/usr/bin/env node
// Shows this computer's pairing code, as a QR code and as text.
//
//   socketagent pair            show the current code
//   socketagent pair --raw      print only the code
//   socketagent pair --reset    start over, then show the new code
//
// --reset is a full start over. It makes a new room ID, a new pairing secret
// and a new AUTH_TOKEN, clears the previous secrets and takes the lock off.
// Devices on the new transport stay on the list, but every one has to scan
// the new code. Devices still on the old path are taken off the list and
// have to be given the new token. It is the fix for a damaged transport.json
// and for a relay room another computer has claimed. A running server does
// the reset itself, so one process owns the files; without one this script
// writes them.

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { localIpv4Addresses, openTransportState, pairingCode, relayUrlForCode } = require("./pairing-code");
// Needs the built server (`npx tsc`), as the transport state does.
const { rotateAuthTokenInEnv, writeEnvValue } = require("#server/env-file");

const serverDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(serverDir, "..");
const envFile = process.env.SOCKETAGENT_ENV || path.join(serverDir, ".env");
const dataDir = process.env.SOCKETAGENT_DATA_DIR
  || process.env.SOCKET_AGENT_DATA_DIR
  || path.join(os.homedir(), ".socket-agent");
const legacyDataDir = path.join(os.homedir(), ".claude-assistant");
const defaultKeysFile = fs.existsSync(path.join(dataDir, "relay-keys.json"))
  ? path.join(dataDir, "relay-keys.json")
  : path.join(legacyDataDir, "relay-keys.json");
const keysFile = process.env.SOCKETAGENT_KEYS_FILE || defaultKeysFile;

/** @param {string} file */
function readEnv(file) {
  /** @type {Record<string, string>} */
  const result = {};
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

/**
 * Asks the running server to start pairing over. Resolves true when it did,
 * false when no server answers on this computer, and rejects when a server
 * answered but refused.
 * @param {Record<string, string>} env
 * @returns {Promise<boolean>}
 */
function resetThroughServer(env) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: Number(env.PORT || "8085"),
      path: "/internal/pairing/reset",
      method: "POST",
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN || ""}` },
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode === 200) resolve(true);
        else reject(new Error(`The running server refused the reset (HTTP ${response.statusCode})`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("The running server did not answer the reset")));
    request.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    request.end();
  });
}

/**
 * Starts pairing over in the files, for when no server is running: the
 * state file, then a new room ID and a new AUTH_TOKEN in .env.
 */
function resetInFiles() {
  const { newOwnerKey } = openTransportState(keysFile).resetPairing();
  writeEnvValue(envFile, "PAIRING_TOKEN", crypto.randomBytes(32).toString("hex"));
  rotateAuthTokenInEnv(envFile);
  if (!newOwnerKey) return;
  // With a new owner key the relay refuses the old link room, so that ID
  // goes too. The server makes a new one when it starts.
  fs.writeFileSync(envFile, fs.readFileSync(envFile, "utf8").replace(/^LINK_ROOM_TOKEN=.*\n?/m, ""), { mode: 0o600 });
}

async function main() {
  if (!fs.existsSync(envFile)) {
    console.error(`No ${envFile} found. Run the SocketAgent installer first.`);
    process.exit(1);
  }
  if (!fs.existsSync(keysFile)) {
    console.error(`No relay key file found at ${keysFile}. Run the SocketAgent installer first.`);
    process.exit(1);
  }

  if (process.argv.includes("--reset")) {
    if (!(await resetThroughServer(readEnv(envFile)))) resetInFiles();
    console.error("Pairing started over. Every device has to scan the new code.");
  }

  const env = readEnv(envFile);
  if (!env.PAIRING_TOKEN) {
    console.error(`No PAIRING_TOKEN found in ${envFile}. Run the SocketAgent installer first.`);
    process.exit(1);
  }

  /** @type {unknown} */
  const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  if (!isRecord(keys) || typeof keys.publicKey !== "string" || !keys.publicKey) {
    console.error(`Relay key file is missing publicKey: ${keysFile}`);
    process.exit(1);
  }

  const state = openTransportState(keysFile);
  if (!state.readable) {
    console.error(`${state.problem}. Run \`socketagent pair --reset\` to start over with a new pairing code.`);
    process.exit(1);
  }

  const payload = pairingCode({
    roomId: env.PAIRING_TOKEN,
    publicKey: keys.publicKey,
    secret: state.currentSecret().secret,
    port: env.PORT || "8085",
    hosts: localIpv4Addresses(),
    relayUrl: relayUrlForCode(env),
  });

  if (process.argv.includes("--raw")) {
    console.log(payload);
    return;
  }

  console.log("");
  console.log("Open SocketAgent, choose Add Computer, and scan this code.");
  console.log("On this computer's network the phone connects directly. Elsewhere it uses the relay.");
  console.log("");
  qrcode.generate(payload, { small: true }, (qr) => {
    for (const line of qr.split("\n")) console.log(`  ${line}`);
  });
  console.log("");
  console.log("If QR scan does not work, paste this in the app:");
  console.log(payload);
  console.log("");
  console.log(`Repo: ${repoRoot}`);
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
