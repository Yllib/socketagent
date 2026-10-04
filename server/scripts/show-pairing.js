#!/usr/bin/env node
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { localIpv4Addresses, pairingCode } = require("./pairing-code");

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

const env = readEnv(envFile);
const pairingToken = env.PAIRING_TOKEN;

if (!pairingToken) {
  console.error(`No PAIRING_TOKEN found in ${envFile}. Run the SocketAgent installer first.`);
  process.exit(1);
}

if (!fs.existsSync(keysFile)) {
  console.error(`No relay key file found at ${keysFile}. Run the SocketAgent installer first.`);
  process.exit(1);
}

/** @type {unknown} */
const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
if (!isRecord(keys) || typeof keys.publicKey !== "string" || !keys.publicKey) {
  console.error(`Relay key file is missing publicKey: ${keysFile}`);
  process.exit(1);
}

const payload = pairingCode({
  pairingToken,
  publicKey: keys.publicKey,
  port: env.PORT || "8085",
  authToken: env.AUTH_TOKEN || "",
  hosts: localIpv4Addresses(),
});

if (process.argv.includes("--raw")) {
  console.log(payload);
  process.exit(0);
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
