// The pairing code the app scans or pastes (wire spec section 6). One code
// covers both ways to connect: the relay from anywhere, and directly when the
// device shares this computer's network. Format:
//   SA3|<room ID>|<computer key>|<pairing secret>|<port>|<address>,<address>[|<relay URL>]
// The room ID is PAIRING_TOKEN in .env. The secret is the current pairing
// secret in transport.json. AUTH_TOKEN is not in the code. Apps older than
// transport v2 reject an SA3 code as invalid.

const os = require("os");
const path = require("path");

// Container and VM bridge adapters a phone on the same Wi-Fi can't reach.
// Hyper-V's external switches are named vEthernet too and carry the real LAN,
// so only its internal Default Switch and WSL switches are left out.
// Linux names are lowercase; matching them case-insensitively would catch
// vEthernet with veth.
const virtualInterface = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|lxc|lxdbr)/;
const virtualWindowsInterface = /^(VirtualBox|VMware|vEthernet \((Default Switch|WSL))/i;

/** Home network ranges first, so the phone tries the likeliest address first. @param {string} address */
function addressRank(address) {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** This computer's IPv4 addresses a phone on the same network could reach. */
function localIpv4Addresses() {
  /** @type {string[]} */
  const results = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (virtualInterface.test(name) || virtualWindowsInterface.test(name)) continue;
    for (const entry of entries || []) {
      // Link-local addresses only appear when a network has no DHCP.
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        results.push(entry.address);
      }
    }
  }
  return [...new Set(results)].sort((a, b) => addressRank(a) - addressRank(b));
}

const DEFAULT_RELAY_URL = "wss://relay.jarofdirt.info";

/**
 * The relay address a device should use, or "" when it is the app's default.
 * A computer that reaches its relay on localhost names the public address in
 * PUBLIC_RELAY_URL, as the server does.
 * @param {Record<string, string | undefined>} env
 */
function relayUrlForCode(env) {
  let relayUrl = env.RELAY_URL || "";
  try {
    const { hostname } = new URL(relayUrl);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      relayUrl = env.PUBLIC_RELAY_URL || DEFAULT_RELAY_URL;
    }
  } catch {
    return "";
  }
  relayUrl = relayUrl.replace(/\/+$/, "");
  return relayUrl.startsWith("wss://") && relayUrl !== DEFAULT_RELAY_URL ? relayUrl : "";
}

/**
 * @param {{ roomId: string, publicKey: string, secret: string, port: string | number, hosts: string[], relayUrl?: string }} parts
 */
function pairingCode({ roomId, publicKey, secret, port, hosts, relayUrl }) {
  const code = `SA3|${roomId}|${publicKey}|${secret}|${port}|${hosts.join(",")}`;
  return relayUrl ? `${code}|${relayUrl}` : code;
}

/**
 * Opens the computer's transport state, which sits beside its key file. The
 * first call after the update makes transport.json from devices.json, the
 * same way the server does. Needs the built server (`npx tsc`).
 * @param {string} keysFile
 */
function openTransportState(keysFile) {
  const { DeviceRegistry } = require("#server/device-registry");
  const dataDir = path.dirname(keysFile);
  return new DeviceRegistry(path.join(dataDir, "transport.json"), path.join(dataDir, "devices.json"));
}

module.exports = { localIpv4Addresses, openTransportState, pairingCode, relayUrlForCode };
