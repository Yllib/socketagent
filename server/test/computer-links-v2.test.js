const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { WebSocketServer } = require("ws");
const dataDir = require("./test-data-dir");

const { ComputerLinkPeerApi } = require("#server/computer-link-peer");
const { ComputerLinkManager, ComputerLinkStore } = require("#server/computer-links");
const { DeviceAuthGate } = require("#server/device-auth");
const { DeviceRegistry } = require("#server/device-registry");
const { RelayClient } = require("#server/relay-client");
const { generateKeyPair, toBase64 } = require("#server/relay-crypto");
const { TransportResponder } = require("#server/transport-responder");
const { isRecord, parseJsonObject } = require("#server/value-guards");

// Computer links on transport v2 (wire spec 5.4, 10.1, 10.2). The source is
// the real ComputerLinkManager and the target the real link-room relay
// client, responder and peer API. Between them stands a socket that does
// what the relay does for a link room: it tells the source the target is
// there and passes frames both ways without reading them.

const LINK_ROOM = "link/room 1";
const TICKET = "ticket-1";
let counter = 0;

function newSecret() {
  return crypto.randomBytes(32).toString("base64");
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{ knowsLinkUpgrade?: boolean, legacyTransport?: boolean }} options
 *   `knowsLinkUpgrade` false makes the target answer `link_upgrade` as a
 *   server from before this release does.
 */
async function computers(t, options = {}) {
  const id = ++counter;
  const registry = new DeviceRegistry(path.join(dataDir, `links-v2-target-${id}.json`));
  const targetKeys = generateKeyPair();
  const sourceKeys = generateKeyPair();
  const sourceKey = toBase64(sourceKeys.publicKey);
  const api = new ComputerLinkPeerApi(registry, targetKeys, {
    serverName: () => "Desktop",
    backends: () => ["claude"],
    listSessions: () => [],
    readTranscript: () => { throw new Error("unused"); },
    searchTranscripts: async () => [],
    runCommand: async () => { throw new Error("unused"); },
    agent: async () => { throw new Error("unused"); },
    ackAgentReport: () => {},
  });
  const target = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: LINK_ROOM,
    keyPair: targetKeys,
    lane: "link",
    legacyTransport: options.legacyTransport,
    responder: new TransportResponder({
      registry, keyPair: () => targetKeys, roomId: () => "control-room", linkRoomId: () => LINK_ROOM, serverVersion: "1.1.531",
    }),
    peerAuth: new DeviceAuthGate(registry, () => "token"),
    onPeerJson: (message, peerId, publicKey, channel) => {
      if (options.knowsLinkUpgrade === false && message.action === "link_upgrade") {
        target.sendReply(peerId, { type: "peer_response", id: String(message.id), ok: false, code: "invalid", error: "Invalid peer request" });
        return;
      }
      void api.handle(message, publicKey, channel).then((response) => {
        if (response) target.sendReply(peerId, response);
      });
    },
    onStatusChange: () => {},
  });
  target.ws = { readyState: 1 };

  /** Every join the stand-in relay saw, and every frame each source socket sent. */
  /** @type {{ url: string, headers: import("node:http").IncomingHttpHeaders, frames: Record<string, unknown>[] }[]} */
  const joins = [];
  /** @type {Map<string, import("ws").WebSocket>} */
  const sockets = new Map();
  target.sendRawFrameToPeer = (peerId, data) => { sockets.get(peerId)?.send(String(data)); };
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  relay.on("connection", (ws, req) => {
    const peerId = `source-${joins.length + 1}`;
    /** @type {Record<string, unknown>[]} */
    const frames = [];
    joins.push({ url: req.url ?? "", headers: req.headers, frames });
    sockets.set(peerId, ws);
    ws.on("message", (data) => {
      frames.push(parseJsonObject(String(data)));
      target.handleRelayMessage({ type: "relay_peer_message", peerId, binary: false, data: String(data) });
    });
    ws.send(JSON.stringify({ type: "peer_connected" }));
  });
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");

  /** @type {import("#server/computer-links").ComputerLinkRecord[]} */
  const online = [];
  const storePath = path.join(dataDir, `links-v2-source-${id}.json`);
  /** A source computer with its own link file. `legacyTransport` false is a source with the old path off. */
  const source = (legacyTransport = true, keys = sourceKeys, file = storePath) => {
    const manager = new ComputerLinkManager(new ComputerLinkStore(file), keys, {
      serverVersion: "1.1.531",
      legacyTransport,
      onEvent: () => {},
      onOnline: (record) => online.push(record),
    });
    t.after(() => manager.closeAll());
    return manager;
  };
  /** @param {string} [linkSecret] */
  const record = (linkSecret) => ({
    name: "Desktop", targetPubkey: toBase64(targetKeys.publicKey), relayUrl: `ws://127.0.0.1:${address.port}`,
    linkRoom: LINK_ROOM, ticket: TICKET, ticketExpiresAt: Date.now() + 60_000,
    access: { read: true, agents: false, commands: false }, confirm: "never",
    ...(linkSecret ? { linkSecret } : {}),
  });
  /** The target lets the source in, as `device_authorize` does. @param {string} [linkSecret] */
  const authorize = (linkSecret) => registry.enroll({
    publicKey: sourceKey, kind: "computer", name: "Dev VM", platform: "computer", via: "link",
    access: { read: true, agents: false, commands: false }, confirm: "never", ...(linkSecret ? { linkSecret } : {}),
  });
  /** Resolves once `check` holds. Fails the test after two seconds. */
  const until = async (/** @type {() => boolean} */ check, what = "the link to settle") => {
    const deadline = Date.now() + 2000;
    while (!check()) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const stored = () => parseJsonObject(fs.readFileSync(storePath, "utf8"));
  return { registry, sourceKey, targetKey: toBase64(targetKeys.publicKey), joins, online, source, record, authorize, until, stored };
}

/** @param {{frames: Record<string, unknown>[]}} join */
function frameTypes(join) {
  return join.frames.map((frame) => (typeof frame.type === "string" ? frame.type : "sealed"));
}

test("a link with a secret on both computers joins by header and runs on v2", async (t) => {
  const env = await computers(t);
  const linkSecret = newSecret();
  env.authorize(linkSecret);
  const manager = env.source();
  manager.set(env.record(linkSecret));
  const connection = manager.get(env.targetKey);
  assert.ok(connection);
  await env.until(() => connection.online);

  // The room and the ticket ride in headers. Nothing is in the URL.
  const [join] = env.joins;
  assert.equal(join.url, "/");
  assert.equal(join.headers["x-socketagent-protocol"], "2");
  assert.equal(join.headers["x-socketagent-role"], "phone");
  assert.equal(join.headers["x-socketagent-room"], encodeURIComponent(LINK_ROOM));
  assert.equal(join.headers["x-socketagent-link-ticket"], TICKET);

  // hs1 on the link lane, then only sealed records. The old key exchange is never sent.
  assert.equal(join.frames[0].type, "hs1");
  assert.equal(join.frames[0].lane, "link");
  assert.equal(join.frames[0].path, "relay");
  const hello = await connection.request("hello", {}, "");
  assert.equal(hello.ok, true);
  assert.equal(isRecord(hello.result) && hello.result.name, "Desktop");
  assert.deepEqual(frameTypes(join), ["hs1", "sealed", "sealed"]);
  assert.equal(env.registry.get(env.sourceKey)?.transport, 2);
  assert.deepEqual(env.online.map((record) => record.name), ["Desktop"]);

  // The app never gets the secret back in the link list.
  assert.equal(JSON.stringify(manager.list()).includes(linkSecret), false);
  assert.deepEqual(manager.list().map((link) => link.online), [true]);
});

test("a link to a target from before this release has no secret and runs on the old path", async (t) => {
  const env = await computers(t, { knowsLinkUpgrade: false });
  // The app left linkSecret out of both messages, because the target is below computerLinks 2.
  env.authorize();
  const manager = env.source();
  manager.set(env.record());
  const connection = manager.get(env.targetKey);
  assert.ok(connection);
  // The link counts as up once the target has turned down the offer to move.
  await env.until(() => env.online.length === 1, "the old target to answer");
  assert.equal(connection.online, true);

  const [join] = env.joins;
  assert.equal(join.headers["x-socketagent-protocol"], "2", "the join is new-style either way");
  assert.equal(join.frames[0].type, "key_exchange");
  assert.equal((await connection.request("hello", {}, "")).ok, true);
  assert.equal(env.joins.length, 1, "it did not reconnect");
  assert.equal(isRecord(env.stored().links[0]) && "linkSecret" in env.stored().links[0], false);
  assert.equal(env.registry.get(env.sourceKey)?.transport, 1);
  assert.equal(env.registry.get(env.sourceKey)?.linkSecret, undefined);
});

test("link_upgrade moves an existing link to v2, and the old key exchange is then refused for that key", async (t) => {
  const env = await computers(t);
  env.authorize();
  const manager = env.source();
  manager.set(env.record());
  const connection = manager.get(env.targetKey);
  assert.ok(connection);
  // Old key exchange, link_upgrade over its session keys, then a second join with hs1.
  await env.until(() => env.joins.length === 2 && connection.online, "the link to come back on v2");

  assert.deepEqual(frameTypes(env.joins[0]), ["key_exchange", "sealed"]);
  assert.equal(env.joins[1].frames[0].type, "hs1");
  const moved = env.registry.get(env.sourceKey);
  assert.equal(moved?.transport, 2);
  const links = env.stored().links;
  assert.ok(Array.isArray(links) && isRecord(links[0]));
  assert.equal(links[0].linkSecret, moved?.linkSecret, "both computers hold the same secret");
  assert.equal(Buffer.from(String(links[0].linkSecret), "base64").length, 32);
  assert.equal((await connection.request("hello", {}, "")).ok, true);
  assert.equal(env.online.length, 1, "the link came up once, on v2");

  // The same key with no secret, as a copy of the source's old state would dial.
  const stale = env.source(true, undefined, path.join(dataDir, `links-v2-stale-${counter}.json`));
  stale.set(env.record());
  const old = stale.get(env.targetKey);
  assert.ok(old);
  await env.until(() => /not authorized/.test(old.offlineReason ?? ""), "the old key exchange to be refused");
  assert.equal(old.online, false);
  assert.equal(env.joins[2].frames[0].type, "key_exchange");
  assert.equal(env.registry.get(env.sourceKey)?.linkSecret, moved?.linkSecret, "the refused peer changed nothing");
  assert.equal(connection.online, true);
});

test("a source with a link secret never falls back to the old key exchange", async (t) => {
  const env = await computers(t);
  // The target would still take the old path from this key, and has no secret for it.
  env.authorize();
  const manager = env.source();
  manager.set(env.record(newSecret()));
  const connection = manager.get(env.targetKey);
  assert.ok(connection);
  await env.until(() => env.joins.length === 1 && env.joins[0].frames.length === 1, "hs1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(frameTypes(env.joins[0]), ["hs1"], "the target stays silent and the source sends nothing else");
  assert.equal(connection.online, false);
  assert.equal(env.registry.get(env.sourceKey)?.transport, 1);

  // A later computer_link_set without a secret keeps the one the link has.
  const again = env.record();
  manager.set({ ...again, name: "Renamed" });
  assert.equal(manager.get(env.targetKey)?.record.linkSecret, connection.record.linkSecret);
  assert.ok(connection.record.linkSecret);
});

test("with the old path off, a link without a secret does not dial and the target ignores a key exchange", async (t) => {
  const off = await computers(t);
  off.authorize();
  const manager = off.source(false);
  manager.set(off.record());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(off.joins.length, 0);
  assert.match(manager.list()[0].offlineReason ?? "", /old transport/);

  // The other way round: a source that still speaks the old path, a target with it off.
  const env = await computers(t, { legacyTransport: false });
  env.authorize();
  const source = env.source();
  source.set(env.record());
  const connection = source.get(env.targetKey);
  assert.ok(connection);
  await env.until(() => env.joins.length === 1 && env.joins[0].frames.length === 1, "the key exchange");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(frameTypes(env.joins[0]), ["key_exchange"]);
  assert.equal(connection.online, false);
});
