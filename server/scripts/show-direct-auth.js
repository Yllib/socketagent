#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const serverDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(serverDir, "..");
const envFile = process.env.SOCKETAGENT_ENV || path.join(serverDir, ".env");

function readEnv(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function localIpv4Addresses() {
  const results = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        results.push(entry.address);
      }
    }
  }
  return [...new Set(results)];
}

const env = readEnv(envFile);
const token = env.AUTH_TOKEN || "";
const port = env.PORT || "8085";
const hosts = localIpv4Addresses();

if (!token) {
  console.error(`No AUTH_TOKEN found in ${envFile}. Run the SocketAgent installer first.`);
  process.exit(1);
}

if (process.argv.includes("--raw") || process.argv.includes("--token")) {
  console.log(token);
  process.exit(0);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    hosts,
    port: Number(port),
    token,
    urls: hosts.map((host) => `ws://${host}:${port}`),
  }, null, 2));
  process.exit(0);
}

console.log("");
console.log("SocketAgent direct/manual connection");
console.log("");
if (hosts.length > 0) {
  console.log("Host/IP candidates:");
  for (const host of hosts) console.log(`  ${host}`);
} else {
  console.log("Host/IP: use this computer's LAN IP address");
}
console.log(`Port: ${port}`);
console.log(`Auth token: ${token}`);
console.log("");
console.log("Use these values for a direct/manual server in the SocketAgent app.");
console.log("Direct mode requires the phone to be on the same network, or your firewall/router/VPN to allow the connection.");
console.log("");
console.log(`Repo: ${repoRoot}`);
