import { execFile } from "child_process";
import { Bonjour, type Service, type ServiceConfig } from "bonjour-service";
import { localIpv4Addresses, localRouteId } from "./local-network";

export const LAN_SERVICE_TYPE = "socketagent";
const ADDRESS_CHECK_MS = 30_000;
const WINDOWS_MDNS_RULE = "SocketAgent mDNS (UDP 5353)";

/** TXT record for the advertisement. Nothing in it is secret. */
export function lanServiceTxt(serverPubkey: string, hosts: string[]): Record<string, string> {
  return { v: "1", id: localRouteId(serverPubkey), hosts: hosts.join(",") };
}

/**
 * Advertises this server as `_socketagent._tcp` so a paired phone can find it
 * after its LAN address changes. Checks the addresses every 30 seconds and
 * republishes, then calls [onAddressesChanged] so connected phones get the new
 * list too. Returns a function that stops advertising.
 */
export function startLanAdvertiser(options: {
  port: number;
  serverPubkey: string;
  onAddressesChanged: () => void;
}): () => void {
  if (process.platform === "win32") ensureWindowsMdnsFirewallRule();
  let hosts = localIpv4Addresses();
  let responders: Bonjour[] = [];

  // One responder per address, each sending through its own interface. A
  // single responder answers through the OS default interface, which on a
  // machine with a VPN or VM adapters can be the wrong network.
  const publish = () => {
    responders = hosts.map((host) => {
      // Bonjour passes these through to multicast-dns, though its types only
      // list service fields. Bind to every address so multicast still arrives.
      const socketOptions: Partial<ServiceConfig> & { interface: string; bind: string } = {
        interface: host,
        bind: "0.0.0.0",
      };
      const bonjour = new Bonjour(socketOptions, (error: unknown) => {
        console.warn(`[mDNS] ${host}: ${error instanceof Error ? error.message : String(error)}`);
      });
      const service: Service = bonjour.publish({
        name: `socketagent-${localRouteId(options.serverPubkey)}`,
        // The computer's own name may not be a valid mDNS host (Windows
        // allows underscores) and lacks .local, which breaks resolving on
        // Android. Answer for a name of our own instead.
        host: `socketagent-${localRouteId(options.serverPubkey)}.local`,
        type: LAN_SERVICE_TYPE,
        port: options.port,
        txt: lanServiceTxt(options.serverPubkey, hosts),
        disableIPv6: true,
        // Each responder announces the same service, so skip the name
        // conflict probe that would see the others.
        probe: false,
      });
      service.on("error", (error: unknown) => {
        console.warn(`[mDNS] Advertising on ${host} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return bonjour;
    });
  };
  const unpublish = (done: () => void) => {
    const closing = responders;
    responders = [];
    let pending = closing.length;
    if (pending === 0) return done();
    for (const bonjour of closing) {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        if (--pending === 0) done();
      });
    }
  };
  publish();
  console.log(`[mDNS] Advertising on ${hosts.join(", ") || "no network yet"}`);

  const timer = setInterval(() => {
    const next = localIpv4Addresses();
    if (next.join(",") === hosts.join(",")) return;
    hosts = next;
    console.log(`[mDNS] Network addresses changed to ${hosts.join(", ") || "none"}`);
    unpublish(publish);
    options.onAddressesChanged();
  }, ADDRESS_CHECK_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    unpublish(() => {});
  };
}

/**
 * Windows drops inbound multicast without a rule. Installs before mDNS
 * support only allowed the server's TCP port, so add the rule here. This needs
 * the elevated startup task current installers register; older "Limited" tasks
 * fail and rely on rerunning setup, which adds the same rule.
 */
function ensureWindowsMdnsFirewallRule(): void {
  execFile("netsh", ["advfirewall", "firewall", "show", "rule", `name=${WINDOWS_MDNS_RULE}`], { windowsHide: true }, (missing) => {
    if (!missing) return;
    execFile(
      "netsh",
      [
        "advfirewall", "firewall", "add", "rule", `name=${WINDOWS_MDNS_RULE}`,
        "dir=in", "action=allow", "protocol=UDP", "localport=5353", "profile=private,domain",
      ],
      { windowsHide: true },
      (error) => {
        if (error) console.warn(`[mDNS] Could not add the Windows firewall rule for UDP 5353: ${error.message}`);
      },
    );
  });
}
