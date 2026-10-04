import * as crypto from "crypto";
import * as net from "net";
import * as os from "os";

// Addresses a phone can have when it shares a network with this computer:
// loopback, private ranges, link-local, and Tailscale's CGNAT range.
const localNetworks = new net.BlockList();
localNetworks.addSubnet("127.0.0.0", 8, "ipv4");
localNetworks.addSubnet("10.0.0.0", 8, "ipv4");
localNetworks.addSubnet("172.16.0.0", 12, "ipv4");
localNetworks.addSubnet("192.168.0.0", 16, "ipv4");
localNetworks.addSubnet("169.254.0.0", 16, "ipv4");
localNetworks.addSubnet("100.64.0.0", 10, "ipv4");
localNetworks.addAddress("::1", "ipv6");
localNetworks.addSubnet("fc00::", 7, "ipv6");
localNetworks.addSubnet("fe80::", 10, "ipv6");

/**
 * Whether a connecting socket's address is on a local network. Used to keep
 * the default listener off the internet when a machine has a public address.
 */
export function isLocalNetworkAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (net.isIPv4(ipv4)) return localNetworks.check(ipv4, "ipv4");
  // Strip a zone index such as fe80::1%en0.
  const ipv6 = address.split("%", 1)[0];
  return net.isIPv6(ipv6) && localNetworks.check(ipv6, "ipv6");
}

// Container and VM bridge adapters a phone on the same Wi-Fi can't reach.
// Hyper-V's external switches are named vEthernet too and carry the real LAN,
// so only its internal Default Switch and WSL switches are left out.
// Mirrors scripts/pairing-code.js, which the installers run before a build.
// Linux names are lowercase; matching them case-insensitively would catch
// vEthernet with veth.
const virtualInterface = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman|lxc|lxdbr)/;
const virtualWindowsInterface = /^(VirtualBox|VMware|vEthernet \((Default Switch|WSL))/i;

/** Home network ranges first, so the phone tries the likeliest address first. */
function addressRank(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/** This computer's IPv4 addresses a phone on the same network could reach, likeliest first. */
export function localIpv4Addresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const results: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (virtualInterface.test(name) || virtualWindowsInterface.test(name)) continue;
    for (const entry of entries ?? []) {
      // Link-local addresses only appear when a network has no DHCP.
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        results.push(entry.address);
      }
    }
  }
  return [...new Set(results)].sort((a, b) => addressRank(a) - addressRank(b));
}

/**
 * The ID this server advertises over mDNS. The app derives the same value from
 * the public key it stored at pairing, so it can pick this server out of every
 * SocketAgent server on the network without anything secret on the wire.
 */
export function localRouteId(serverPubkey: string): string {
  return crypto.createHash("sha256").update(serverPubkey.trim()).digest("hex").slice(0, 16);
}

/**
 * Listens on [host]. When [fallbackHost] is given and [host] collides with a
 * listener that already holds the port on one address, such as Tailscale
 * serve on a tailnet IP, retries on [fallbackHost] instead of failing. Resolves
 * with the host actually bound; rejects on any other failure so the caller can
 * exit rather than run without listening.
 */
export async function listenWithFallback(
  server: net.Server,
  port: number,
  host: string,
  fallbackHost?: string,
): Promise<string> {
  const attempt = (address: string) => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, address, () => {
      server.off("error", onError);
      resolve();
    });
  });
  try {
    await attempt(host);
    return host;
  } catch (error) {
    const inUse = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
    if (!fallbackHost || !inUse) throw error;
    await attempt(fallbackHost);
    return fallbackHost;
  }
}
