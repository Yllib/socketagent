// The pairing code the app scans. One code covers both ways to connect: the
// relay from anywhere, and directly when the phone shares this computer's
// network. Format:
//   SA|<pairing token>|<public key>|<port>|<auth token>|<address>,<address>
// The app also accepts the older SA|<pairing token>|<public key> relay code.

const os = require("os");

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

/**
 * @param {{ pairingToken: string, publicKey: string, port: string | number, authToken: string, hosts: string[] }} parts
 */
function pairingCode({ pairingToken, publicKey, port, authToken, hosts }) {
  return `SA|${pairingToken}|${publicKey}|${port}|${authToken}|${hosts.join(",")}`;
}

module.exports = { localIpv4Addresses, pairingCode };
