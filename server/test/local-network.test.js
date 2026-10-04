const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const test = require("node:test");

const { isLocalNetworkAddress, listenWithFallback } = require("#server/local-network");

test("accepts private, loopback, link-local and Tailscale addresses", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.20",
    "169.254.10.1", "100.101.102.103", "::ffff:192.168.1.20", "::1", "fd7a:115c::1", "fe80::1%en0",
  ]) {
    assert.equal(isLocalNetworkAddress(address), true, address);
  }
});

test("rejects public addresses", () => {
  for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "::ffff:1.1.1.1", "2001:4860::8888", undefined, ""]) {
    assert.equal(isLocalNetworkAddress(address), false, String(address));
  }
});

const { localIpv4Addresses, localRouteId } = require("#server/local-network");
const { lanServiceTxt } = require("#server/lan-advertiser");

test("lists reachable IPv4 addresses, home ranges first, without container bridges", () => {
  /** @param {string} address */
  const entry = (address, internal = false) => ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null });
  const hosts = localIpv4Addresses({
    lo: [entry("127.0.0.1", true)],
    docker0: [entry("172.17.0.1")],
    tailscale0: [entry("100.101.102.103")],
    eth1: [entry("10.0.0.5")],
    wlan0: [entry("192.168.1.20"), { ...entry("fe80::1"), family: "IPv6" }],
  });
  assert.deepEqual(hosts, ["192.168.1.20", "10.0.0.5", "100.101.102.103"]);
});

test("keeps a Hyper-V external switch, the real LAN on many Windows desktops", () => {
  /** @param {string} address */
  const entry = (address) => ({ address, family: "IPv4", internal: false, netmask: "", mac: "", cidr: null });
  // The adapter list of a real Windows desktop.
  const hosts = localIpv4Addresses({
    "vEthernet (JOD LAN External)": [entry("10.10.10.69")],
    "VMware Network Adapter VMnet8": [entry("192.168.61.1")],
    "vEthernet (Default Switch)": [entry("172.30.176.1")],
    "vEthernet (WSL (Hyper-V firewall))": [entry("172.25.0.1")],
    "Wi-Fi": [entry("169.254.56.176")],
  });
  assert.deepEqual(hosts, ["10.10.10.69"]);
});

test("advertises a key-derived ID the app can match, and no secrets", () => {
  // The app's localRouteId test uses the same vector.
  assert.equal(localRouteId("server-key"), "0e7492b2aec83281");
  assert.deepEqual(lanServiceTxt("server-key", ["192.168.1.20", "10.0.0.5"]), {
    v: "1",
    id: localRouteId("server-key"),
    hosts: "192.168.1.20,10.0.0.5",
  });
});

/**
 * The address a listening TCP server is bound to.
 * @param {import("node:net").Server} server
 */
function boundAddress(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

// Tailscale serve holds the server port on the tailnet address only. Linux
// routes all of 127/8 to loopback, so 127.0.0.2 stands in for that address.
test("falls back to loopback when the port is held on one other address", async (t) => {
  const holder = net.createServer();
  holder.listen(0, "127.0.0.2");
  try { await once(holder, "listening"); } catch { t.skip("127.0.0.2 is not routable here"); return; }
  const { port } = boundAddress(holder);
  const server = net.createServer();
  t.after(() => { holder.close(); server.close(); });
  let wildcardFree = true;
  const probe = net.createServer();
  probe.once("error", () => { wildcardFree = false; });
  probe.listen(port, "0.0.0.0");
  await new Promise((resolve) => setTimeout(resolve, 50));
  probe.close();
  if (wildcardFree) { t.skip("this OS allows a wildcard bind beside a specific one"); return; }

  assert.equal(await listenWithFallback(server, port, "0.0.0.0", "127.0.0.1"), "127.0.0.1");
  assert.equal(boundAddress(server).address, "127.0.0.1");
});

test("rejects instead of running without a listener", async (t) => {
  const holder = net.createServer().listen(0, "127.0.0.1");
  await once(holder, "listening");
  const server = net.createServer();
  t.after(() => { holder.close(); server.close(); });
  await assert.rejects(
    listenWithFallback(server, boundAddress(holder).port, "127.0.0.1", "127.0.0.1"),
    { code: "EADDRINUSE" },
  );
  await assert.rejects(listenWithFallback(server, boundAddress(holder).port, "127.0.0.1"), { code: "EADDRINUSE" });
});
