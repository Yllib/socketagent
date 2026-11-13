const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const { WebSocket, WebSocketServer } = require("ws");
const dataDir = require("./test-data-dir");

const { broadcastDirectCapabilities, removeRegisteredKey } = require("#server/device-removal");
const { DeviceRegistry } = require("#server/device-registry");
const { DirectClientTransport } = require("#server/direct-client-transport");
const { SessionKeyedPeerStore, SessionOffer, generateKeyPair, toBase64 } = require("#server/relay-crypto");
const { parseJsonObject } = require("#server/value-guards");

// `device_remove` against live old-path direct sockets. The registry change
// in the middle of a removal broadcasts capabilities, and the payload for a
// client that holds AUTH_TOKEN carries the token made for that removal. The
// removed device must not be sent it.

let counter = 0;

/**
 * A listener that wraps every socket in a DirectClientTransport, signs in a
 * client that seals the right token and broadcasts capabilities on every
 * registry change, as index.ts does.
 * @param {import("node:test").TestContext} t
 */
async function listener(t) {
  const registry = new DeviceRegistry(path.join(dataDir, `removal-${++counter}.json`));
  const serverKeys = generateKeyPair();
  const sessionKeyedPeers = new SessionKeyedPeerStore();
  let token = "token-before";
  /** @type {Set<InstanceType<typeof DirectClientTransport>>} */
  const clients = new Set();
  /** @type {Map<InstanceType<typeof DirectClientTransport>, import("ws").WebSocket>} */
  const sockets = new Map();
  const payloads = () => ({
    withToken: { type: "server_capabilities", directRoute: { port: 8085, token } },
    withoutToken: { type: "server_capabilities", directRoute: { port: 8085 } },
    v2: { type: "server_capabilities", transport: { version: 2 } },
  });
  const isRecordedDevice = (/** @type {string} */ key) => registry.get(key)?.kind === "device";
  registry.onChange(() => broadcastDirectCapabilities(clients, payloads(), isRecordedDevice));

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  server.on("connection", (ws) => {
    const transport = new DirectClientTransport(ws, serverKeys, sessionKeyedPeers, { authenticated: false, requireEncryptedAuth: true });
    sockets.set(transport, ws);
    ws.on("message", (data) => {
      const frame = parseJsonObject(String(data));
      if (frame.type === "key_exchange") return transport.handleKeyExchange(frame);
      const message = transport.decryptTextEnvelope(frame);
      if (message.type !== "direct_auth" || message.token !== token) return;
      // What the `direct_auth` handler does once the gate lets a token holder in.
      transport.holdsAuthToken = true;
      transport.authenticate(false);
      clients.add(transport);
      transport.send(JSON.stringify(payloads().withToken));
    });
    ws.on("close", () => { transport.close(); clients.delete(transport); sockets.delete(transport); });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  /** A recorded device that signs in with the token on an `e2e=1` socket, and what it is sent from then on. */
  const connect = async (/** @type {string} */ name, /** @type {import("#server/relay-crypto").KeyPair} */ keys) => {
    const publicKey = toBase64(keys.publicKey);
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/?e2e=1`);
    const offer = new SessionOffer(keys, serverKeys.publicKey);
    /** @type {import("#server/relay-crypto").PeerChannel | null} */
    let channel = null;
    /** @type {Record<string, unknown>[]} */
    const received = [];
    /** @type {(() => void)[]} */
    const waiting = [];
    let closeCode = 0;
    const wake = () => { for (const resolve of waiting.splice(0)) resolve(); };
    ws.on("message", (data) => {
      const frame = parseJsonObject(String(data));
      if (!channel) {
        channel = offer.accept(frame, new SessionKeyedPeerStore());
        ws.send(JSON.stringify(channel.sealText(JSON.stringify({ type: "direct_auth", token, name, platform: "android" }))));
        return;
      }
      assert.ok(typeof frame.n === "string" && typeof frame.c === "string");
      received.push(parseJsonObject(channel.openText({ n: frame.n, c: frame.c })));
      wake();
    });
    ws.on("close", (code) => { closeCode = code; wake(); });
    await once(ws, "open");
    ws.send(JSON.stringify(offer.message()));
    const self = {
      publicKey,
      received,
      get closeCode() { return closeCode; },
      /** Resolves once `count` messages have arrived or the socket has closed. */
      async until(/** @type {number} */ count) {
        while (received.length < count && closeCode === 0) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
      },
      async closed() {
        while (closeCode === 0) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
      },
    };
    await self.until(1);
    assert.deepEqual(received[0], payloads().withToken, "a token holder is sent the token it proved");
    return self;
  };
  /** Two devices, recorded before either connects so that enrolling one sends the other nothing. */
  const twoDevices = async (/** @type {string} */ first, /** @type {string} */ second) => {
    const pairs = [first, second].map((name) => ({ name, keys: generateKeyPair() }));
    for (const { name, keys } of pairs) registry.enroll({ publicKey: toBase64(keys.publicKey), kind: "device", name, platform: "android", via: "token" });
    return [await connect(pairs[0].name, pairs[0].keys), await connect(pairs[1].name, pairs[1].keys)];
  };

  /** Every call to drop push registrations, in order. @type {{ key: string, alsoUnkeyed: boolean }[]} */
  const pushDrops = [];
  /** @type {import("#server/device-removal").DeviceRemovalSteps} */
  const steps = {
    dropDeviceChannels: (key) => { for (const transport of sockets.keys()) if (transport.peerKey === key) transport.drop("Removed"); },
    rotateAuthToken: () => { token = "token-after"; },
    revoke: (key) => { registry.revoke(key); },
    clearPending: () => {},
    renewPairingSecret: () => { registry.rotateSecret(); },
    dropPushRegistrations: (key, alsoUnkeyed) => { pushDrops.push({ key, alsoUnkeyed }); },
    revokeConnector: () => assert.fail("not a connector"),
    dropLinkPeers: () => assert.fail("not a linked computer"),
  };
  /** The server's end of a device's socket. */
  const transportOf = (/** @type {string} */ key) => [...sockets.keys()].find((transport) => transport.peerKey === key);
  return { registry, twoDevices, steps, transportOf, pushDrops };
}

/** Every token a device was sent in capabilities, in order. */
const tokensSent = (/** @type {{ received: Record<string, unknown>[] }} */ device) => device.received.map((message) => parseJsonObject(JSON.stringify(message.directRoute ?? {})).token);

test("a removed device's open direct socket closes before the new AUTH_TOKEN is broadcast", async (t) => {
  const { registry, twoDevices, steps, pushDrops } = await listener(t);
  const [removed, kept] = await twoDevices("Removed phone", "Kept phone");
  const entry = registry.get(removed.publicKey);
  assert.ok(entry);

  removeRegisteredKey(entry, false, steps);
  // Its push registrations go, and so do those under no key, which may be its own.
  assert.deepEqual(pushDrops, [{ key: removed.publicKey, alsoUnkeyed: true }]);

  // The device that stays hears the new token: once for the removal, once for the new secret.
  await kept.until(3);
  assert.deepEqual(tokensSent(kept), ["token-before", "token-after", "token-after"]);
  await removed.closed();
  assert.equal(removed.closeCode, 1008);
  assert.deepEqual(tokensSent(removed), ["token-before"], "nothing reached the removed device after its removal began");
  assert.equal(registry.get(removed.publicKey), undefined);
});

test("a dropped old-path socket is signed out in the same tick, before the peer answers the close", async (t) => {
  const { twoDevices, transportOf } = await listener(t);
  const [removed] = await twoDevices("Removed phone", "Kept phone");
  const transport = transportOf(removed.publicKey);
  assert.ok(transport?.isAuthenticated);

  transport.drop("Removed");

  // index.ts reads no frame from a dropped socket, and it is signed out anyway.
  assert.equal(transport.dropped, true);
  assert.equal(transport.isAuthenticated, false);
  assert.equal(transport.heldForApproval, false);
  await removed.closed();
  assert.equal(removed.closeCode, 1008);
});

test("a socket whose key is no longer recorded is not sent the token, even while it is open", async (t) => {
  const { registry, twoDevices, steps } = await listener(t);
  const [removed, kept] = await twoDevices("Removed phone", "Kept phone");
  const entry = registry.get(removed.publicKey);
  assert.ok(entry);

  // A socket the drop missed: the broadcast alone has to keep the token from it.
  removeRegisteredKey(entry, false, { ...steps, dropDeviceChannels: () => {} });

  await Promise.all([kept.until(3), removed.until(3)]);
  assert.deepEqual(tokensSent(kept), ["token-before", "token-after", "token-after"]);
  assert.deepEqual(tokensSent(removed), ["token-before", undefined, undefined]);
});

test("Forget keeps the token, renews the pairing secret, and still closes the device's sockets first", async (t) => {
  const { registry, twoDevices, steps, pushDrops } = await listener(t);
  const [forgotten, kept] = await twoDevices("Forgotten phone", "Kept phone");
  const entry = registry.get(forgotten.publicKey);
  assert.ok(entry);
  const secret = registry.currentSecret().secret;

  removeRegisteredKey(entry, true, steps);
  // Forget drops only the registrations stored under the forgotten key.
  assert.deepEqual(pushDrops, [{ key: forgotten.publicKey, alsoUnkeyed: false }]);

  // The removal and the new secret each broadcast capabilities to the device that stays.
  await kept.until(3);
  await forgotten.closed();
  assert.deepEqual(tokensSent(kept), ["token-before", "token-before", "token-before"]);
  assert.deepEqual(tokensSent(forgotten), ["token-before"]);
  // The forgotten install still holds the old secret. It is no longer the current one.
  assert.notEqual(registry.currentSecret().secret, secret);
});
