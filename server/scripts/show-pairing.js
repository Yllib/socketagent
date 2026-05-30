#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const qrcode = require("qrcode-terminal");

const serverDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(serverDir, "..");
const envFile = process.env.SOCKETAGENT_ENV || path.join(serverDir, ".env");
const dataDir = process.env.SOCKETAGENT_DATA_DIR || path.join(os.homedir(), ".socketagent");
const legacyDataDir = path.join(os.homedir(), ".claude-assistant");
let keysFile = process.env.SOCKETAGENT_KEYS_FILE || path.join(dataDir, "relay-keys.json");
if (!process.env.SOCKETAGENT_KEYS_FILE && !fs.existsSync(keysFile)) {
  const legacyKeysFile = path.join(legacyDataDir, "relay-keys.json");
  if (fs.existsSync(legacyKeysFile)) keysFile = legacyKeysFile;
}

function readEnv(file) {
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

const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
if (!keys.publicKey) {
  console.error(`Relay key file is missing publicKey: ${keysFile}`);
  process.exit(1);
}

const payload = `SA|${pairingToken}|${keys.publicKey}`;

if (process.argv.includes("--raw")) {
  console.log(payload);
  process.exit(0);
}

console.log("");
console.log("Scan this QR code with the SocketAgent app:");
console.log("");
qrcode.generate(payload, { small: true }, (qr) => {
  for (const line of qr.split("\n")) console.log(`  ${line}`);
});
console.log("");
console.log("If QR scan does not work, paste this in the app:");
console.log(payload);
console.log("");
console.log(`Repo: ${repoRoot}`);
