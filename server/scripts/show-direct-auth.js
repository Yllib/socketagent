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
const keysFile = process.env.SOCKETAGENT_KEYS_FILE
  || (fs.existsSync(path.join(dataDir, "relay-keys.json"))
    ? path.join(dataDir, "relay-keys.json")
    : path.join(legacyDataDir, "relay-keys.json"));

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

function serverPublicKey() {
  if (!fs.existsSync(keysFile)) return "";
  /** @type {unknown} */
  const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  return isRecord(keys) && typeof keys.publicKey === "string" ? keys.publicKey : "";
}

const env = readEnv(envFile);
const token = env.AUTH_TOKEN || "";
const port = env.PORT || "8085";
const hosts = localIpv4Addresses();
const publicKey = serverPublicKey();

if (!token) {
  console.error(`No AUTH_TOKEN found in ${envFile}. Run the SocketAgent installer first.`);
  process.exit(1);
}

if (process.argv.includes("--raw") || process.argv.includes("--token")) {
  console.log(token);
  process.exit(0);
}

if (!publicKey) {
  console.error(`No public key found in ${keysFile}. Run the SocketAgent installer first.`);
  process.exit(1);
}

// The same code `socketagent pair` shows. Scanned on this network, the app
// connects directly.
const code = pairingCode({ pairingToken: env.PAIRING_TOKEN || "", publicKey, port, authToken: token, hosts });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    hosts,
    port: Number(port),
    token,
    publicKey,
    pairingCode: code,
    urls: hosts.map((host) => `ws://${host}:${port}`),
  }, null, 2));
  process.exit(0);
}

console.log("");
console.log("SocketAgent direct connection");
console.log("");
if (hosts.length > 0) {
  console.log("With your phone on this computer's network, open SocketAgent,");
  console.log("choose Add Computer, and scan this code:");
  console.log("");
  qrcode.generate(code, { small: true }, (qr) => {
    for (const line of qr.split("\n")) console.log(`  ${line}`);
  });
  console.log("");
} else {
  console.log("No local network address found. Connect this computer to a network first.");
  console.log("");
}
console.log("Manual values:");
console.log(`  Address:    ${hosts.join(", ") || "this computer's LAN IP address"}`);
console.log(`  Port:       ${port}`);
console.log(`  Auth token: ${token}`);
console.log(`  Public key: ${publicKey}`);
console.log("");
console.log("Away from this network, use the relay or a VPN such as Tailscale.");
console.log("");
console.log(`Repo: ${repoRoot}`);
