#!/usr/bin/env node
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * SocketAgent setup script — generates server configuration.
 *
 * Generates AUTH_TOKEN, PAIRING_TOKEN, NaCl key pair, .env, and relay-keys.json.
 * Preserves existing values on re-run (safe for upgrades).
 * Outputs QR payload JSON on the last line of stdout.
 *
 * Usage: node setup.js --env-file <path> --keys-file <path> --relay-url <url> [--default-cwd <path>] [--port <port>] [--bind-host <host>]
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const { localIpv4Addresses, pairingCode } = require("./pairing-code");

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
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) existingEnv[match[1]] = match[2];
  }
  console.log(`Read existing config from ${envFile}`);
}

// --- Generate values (only if not already present) ---
const authToken =
  existingEnv.AUTH_TOKEN || crypto.randomBytes(32).toString("hex");
const pairingToken = existingEnv.PAIRING_TOKEN || crypto.randomUUID();
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
const envContent = [
  `PORT=${envPort}`,
  ...(envBindHost ? [`BIND_HOST=${envBindHost}`] : []),
  `AUTH_TOKEN=${authToken}`,
  `DEFAULT_CWD=${envCwd}`,
  `RELAY_URL=${envRelay}`,
  `PAIRING_TOKEN=${pairingToken}`,
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

// --- Output QR payload on last line (parsed by installer) ---
// Relay URL is hardcoded in the app. Plain delimited, no JSON, which avoids
// PowerShell stripping quotes when passing it to qrcode-terminal.
const qrPayload = pairingCode({
  pairingToken,
  publicKey: publicKeyB64,
  port: envPort,
  authToken,
  hosts: localIpv4Addresses(),
});

console.log(qrPayload);
