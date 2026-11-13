#!/usr/bin/env node
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * SocketAgent setup script — generates server configuration.
 *
 * Generates AUTH_TOKEN, the room ID (PAIRING_TOKEN), the NaCl key pair, .env,
 * relay-keys.json and, beside it, transport.json with the pairing secret.
 * Preserves existing values on re-run (safe for upgrades). When it has to
 * make a new room ID for a computer that already has a transport.json, as
 * after the installer's reset-pairing option, pairing starts over: a new
 * secret and the lock off.
 * Outputs the SA3 pairing code on the last line of stdout.
 * Run it after the server is built: it loads the compiled device registry.
 *
 * Usage: node setup.js --envfile <path> --keysfile <path> --relay-url <url> [--default-cwd <path>] [--port <port>] [--bind-host <host>]
 * (Not `--env-file`: node takes that flag for itself and fails when the file does not exist yet.)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const { localIpv4Addresses, openTransportState, pairingCode, relayUrlForCode } = require("./pairing-code");

// Parse CLI arguments
/** @type {Record<string, string>} */
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  args[key] = process.argv[i + 1];
}

const envFile = args["envfile"] || args["env-file"];
const keysFile = args["keysfile"] || args["keys-file"];
const relayUrl = args["relay-url"] || "";
const defaultCwd = args["default-cwd"] || process.cwd();
const port = args["port"] || "8085";
const bindHost = args["bind-host"] || args["bindhost"] || "";

if (!envFile || !keysFile) {
  console.error(
    "Usage: node setup.js --envfile <path> --keysfile <path> [--relay-url <url>] [--default-cwd <path>] [--port <port>] [--bind-host <host>]"
  );
  process.exit(1);
}

// --- Read existing .env if present (preserve existing values) ---
/** @type {Record<string, string>} */
const existingEnv = {};
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) existingEnv[match[1]] = match[2];
  }
  console.log(`Read existing config from ${envFile}`);
}

// --- Generate values (only if not already present) ---
const authToken =
  existingEnv.AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
// A carried-over install keeps its room ID. A new one is 32 random bytes in hex.
const pairingToken = existingEnv.PAIRING_TOKEN || crypto.randomBytes(32).toString("hex");
const envPort = existingEnv.PORT || port;
// The server listens on the local network unless BIND_HOST says otherwise.
// 127.0.0.1 was the old written default, so it is dropped rather than kept.
const existingBindHost = existingEnv.BIND_HOST === "127.0.0.1" ? "" : existingEnv.BIND_HOST || "";
const envBindHost = bindHost || existingBindHost;
const envRelay = existingEnv.RELAY_URL || relayUrl;
const envCwd = existingEnv.DEFAULT_CWD || defaultCwd;

/** @param {string} filePath */
function secureSecretFileMode(filePath) {
  if (process.platform === "win32") return;
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch (e) {
    console.warn(`Warning: failed to restrict permissions on ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Write .env ---
// Keys this script doesn't manage, such as the LINK_ROOM_TOKEN the server
// writes, are kept. Dropping that one breaks every link to this computer.
const managedKeys = new Set(["PORT", "BIND_HOST", "AUTH_TOKEN", "DEFAULT_CWD", "RELAY_URL", "PAIRING_TOKEN"]);
const envContent = [
  `PORT=${envPort}`,
  ...(envBindHost ? [`BIND_HOST=${envBindHost}`] : []),
  `AUTH_TOKEN=${authToken}`,
  `DEFAULT_CWD=${envCwd}`,
  `RELAY_URL=${envRelay}`,
  `PAIRING_TOKEN=${pairingToken}`,
  ...Object.entries(existingEnv)
    .filter(([key]) => !managedKeys.has(key))
    .map(([key, value]) => `${key}=${value}`),
].join("\n") + "\n";

fs.mkdirSync(path.dirname(envFile), { recursive: true });
fs.writeFileSync(envFile, envContent, { mode: 0o600 });
secureSecretFileMode(envFile);
console.log(`Wrote ${envFile}`);

// --- Generate or load NaCl key pair ---
/** @type {string} */
let publicKeyB64;
/** @type {string} */
let secretKeyB64;

if (fs.existsSync(keysFile)) {
  /** @type {unknown} */
  const data = JSON.parse(fs.readFileSync(keysFile, "utf-8"));
  if (!isRecord(data) || typeof data.publicKey !== "string" || typeof data.secretKey !== "string") {
    throw new Error("Invalid existing relay key file; refusing to replace it");
  }
  publicKeyB64 = data.publicKey;
  secretKeyB64 = data.secretKey;
  secureSecretFileMode(keysFile);
  console.log(`Loaded existing key pair from ${keysFile}`);
} else {
  const kp = nacl.box.keyPair();
  publicKeyB64 = Buffer.from(kp.publicKey).toString("base64");
  secretKeyB64 = Buffer.from(kp.secretKey).toString("base64");

  const keysDir = path.dirname(keysFile);
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  fs.writeFileSync(
    keysFile,
    JSON.stringify(
      { publicKey: publicKeyB64, secretKey: secretKeyB64 },
      null,
      2
    ),
    { mode: 0o600 }
  );
  secureSecretFileMode(keysFile);
  console.log(`Generated new key pair -> ${keysFile}`);
}

// --- Pairing secret ---
const stateFile = path.join(path.dirname(keysFile), "transport.json");
const hadState = fs.existsSync(stateFile);
const state = openTransportState(keysFile);
// A new room ID for a computer that was already set up means every device
// scans again, so the old secrets and the lock go too.
if (hadState && !existingEnv.PAIRING_TOKEN) state.resetPairing();
if (!state.readable) {
  console.error(`${state.problem}. Run \`socketagent pair --reset\` to start over with a new pairing code.`);
  process.exit(1);
}

// --- Output the pairing code on last line (parsed by installer) ---
// Plain delimited, no JSON, which avoids PowerShell stripping quotes when
// passing it to qrcode-terminal.
const qrPayload = pairingCode({
  roomId: pairingToken,
  publicKey: publicKeyB64,
  secret: state.currentSecret().secret,
  port: envPort,
  hosts: localIpv4Addresses(),
  relayUrl: relayUrlForCode({ ...existingEnv, RELAY_URL: envRelay }),
});

console.log(qrPayload);
