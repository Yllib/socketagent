const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const {
  PeerChannel,
  SessionKeyRequiredError,
  SessionKeyedPeerStore,
  SessionOffer,
  acceptKeyExchange,
  decrypt,
  encrypt,
  generateKeyPair,
  toBase64,
} = require("#server/relay-crypto");
const { RelayClient } = require("#server/relay-client");
const { parseJsonObject } = require("#server/value-guards");

/** A phone and server pair with a completed session handshake. */
function handshake(serverPeers = new SessionKeyedPeerStore(), phonePeers = new SessionKeyedPeerStore()) {
  const server = generateKeyPair();
  const phone = generateKeyPair();
  const offer = new SessionOffer(phone, server.publicKey);
  const exchange = acceptKeyExchange(offer.message(), server, serverPeers);
  const phoneChannel = offer.accept({ type: "key_exchange_ack", ...exchange.ack }, phonePeers);
  return { server, phone, serverChannel: exchange.channel, phoneChannel, serverPeers, phonePeers };
}

test("session frames open once and in order", () => {
  const { serverChannel, phoneChannel } = handshake();
  assert.equal(serverChannel.sessionKeyed, true);
  assert.equal(phoneChannel.sessionKeyed, true);

  const first = phoneChannel.sealText('{"type":"prompt","text":"one"}');
  const second = phoneChannel.sealBinary(new Uint8Array([0x4a, 0x7b, 0x7d]));
  const third = phoneChannel.sealText('{"type":"prompt","text":"three"}');

  assert.equal(serverChannel.openText(first), '{"type":"prompt","text":"one"}');
  assert.throws(() => serverChannel.openText(first), /Replayed or reordered/);
  // A skipped frame is fine; going back to it afterwards is not.
  assert.equal(serverChannel.openText(third), '{"type":"prompt","text":"three"}');
  assert.throws(() => serverChannel.openBinary(second), /Replayed or reordered/);

  const reply = serverChannel.sealText('{"type":"text"}');
  assert.equal(phoneChannel.openText(reply), '{"type":"text"}');
  assert.throws(() => phoneChannel.openText(reply), /Replayed or reordered/);
});

test("a frame does not open when reflected to its sender or moved to another connection", () => {
  const first = handshake();
  const toServer = first.phoneChannel.sealText("{}");
  assert.throws(() => first.phoneChannel.openText(toServer), /other direction/);

  // A second connection between the same two keys agrees a different key.
  const offer = new SessionOffer(first.phone, first.server.publicKey);
  const exchange = acceptKeyExchange(offer.message(), first.server, first.serverPeers);
  offer.accept({ type: "key_exchange_ack", ...exchange.ack }, first.phonePeers);
  assert.throws(() => exchange.channel.openText(toServer), /Decryption failed/);
});

test("old peers keep the static box in both directions", () => {
  const server = generateKeyPair();
  const phone = generateKeyPair();

  // An app before session keys sends only its public key.
  const legacy = acceptKeyExchange({ type: "key_exchange", pubkey: toBase64(phone.publicKey) }, server, new SessionKeyedPeerStore());
  assert.deepEqual(legacy.ack, {});
  assert.equal(legacy.channel.sessionKeyed, false);
  const fromOldApp = encrypt('{"type":"list_sessions"}', server.publicKey, phone.secretKey);
  assert.equal(legacy.channel.openText(fromOldApp), '{"type":"list_sessions"}');
  assert.equal(decrypt(legacy.channel.sealText("{}"), server.publicKey, phone.secretKey), "{}");

  // A server before session keys acks without one.
  const offer = new SessionOffer(phone, server.publicKey);
  const channel = offer.accept({ type: "key_exchange_ack", device: "approved" }, new SessionKeyedPeerStore());
  assert.equal(channel.sessionKeyed, false);
  assert.equal(channel.openText(encrypt("{}", phone.publicKey, server.secretKey)), "{}");
  assert.equal(decrypt(channel.sealText("{}"), phone.publicKey, server.secretKey), "{}");
});

test("a key that used session keys is refused the static box afterwards", () => {
  const file = path.join(dataDir, `session-keyed-${process.pid}-${Date.now()}.json`);
  const store = new SessionKeyedPeerStore(file);
  const { server, phone } = handshake(store, store);
  // Reloaded from disk, as after a restart.
  const peers = new SessionKeyedPeerStore(file);
  assert.equal(peers.has(toBase64(phone.publicKey)), true);
  assert.equal(peers.has(toBase64(server.publicKey)), true);

  assert.throws(
    () => acceptKeyExchange({ type: "key_exchange", pubkey: toBase64(phone.publicKey) }, server, peers),
    SessionKeyRequiredError,
  );
  const offer = new SessionOffer(phone, server.publicKey);
  assert.throws(() => offer.accept({ type: "key_exchange_ack" }, peers), SessionKeyRequiredError);
  fs.rmSync(file, { force: true });
});

test("an offer only counts with a proof from the static key it names", () => {
  const server = generateKeyPair();
  const phone = generateKeyPair();
  const other = generateKeyPair();
  const message = new SessionOffer(phone, server.publicKey).message();

  // Someone else's key cannot borrow this proof.
  assert.throws(() => acceptKeyExchange({ ...message, pubkey: toBase64(other.publicKey) }, server, new SessionKeyedPeerStore()));
  // Nor can the session key be swapped under it.
  const swapped = { ...message, session: { ...message.session, key: toBase64(generateKeyPair().publicKey) } };
  assert.throws(() => acceptKeyExchange(swapped, server, new SessionKeyedPeerStore()), /does not match/);

  // An answer made for a different offer is refused.
  const offer = new SessionOffer(phone, server.publicKey);
  const stale = acceptKeyExchange(new SessionOffer(phone, server.publicKey).message(), server, new SessionKeyedPeerStore());
  assert.throws(() => offer.accept({ type: "key_exchange_ack", ...stale.ack }, new SessionKeyedPeerStore()), /does not match/);
});

/** A RelayClient on a fake multi-device relay socket that records each peer's frames. */
function relayHarness() {
  const server = generateKeyPair();
  /** @type {Array<Record<string, unknown>>} */
  const delivered = [];
  /** @type {{peerId: string, data: Record<string, unknown>}[]} */
  const frames = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: "test",
    keyPair: server,
    sessionKeyedPeers: new SessionKeyedPeerStore(),
    serverCapabilities: () => ({ type: "server_capabilities", sessionKeyVersion: 1 }),
    onMessage: (msg) => delivered.push(msg),
    onStatusChange() {},
  });
  client.ws = {
    readyState: 1,
    bufferedAmount: 0,
    /** @param {string} data */
    send(data) {
      const routed = parseJsonObject(data);
      frames.push({ peerId: String(routed.peerId), data: parseJsonObject(String(routed.data)) });
    },
  };
  client.relaySupportsMultiDevice = true;
  /** @param {string} peerId @param {Record<string, unknown>} message */
  const fromPeer = (peerId, message) => client.handleRelayMessage({
    type: "relay_peer_message", peerId, binary: false, data: JSON.stringify(message),
  });
  /** @param {string} peerId */
  const framesFor = (peerId) => frames.filter((frame) => frame.peerId === peerId).map((frame) => frame.data);
  return { server, client, delivered, frames, framesFor, fromPeer };
}

test("the relay client acts on a captured phone frame once, on its own connection only", () => {
  const { server, delivered, framesFor, fromPeer } = relayHarness();
  const phone = generateKeyPair();
  const peers = new SessionKeyedPeerStore();

  const offer = new SessionOffer(phone, server.publicKey);
  fromPeer("p1", offer.message());
  const [ack] = framesFor("p1");
  assert.equal(ack.type, "key_exchange_ack");
  const channel = offer.accept(ack, peers);
  assert.equal(channel.sessionKeyed, true);

  const prompt = channel.sealText(JSON.stringify({ type: "prompt", text: "run this" }));
  fromPeer("p1", prompt);
  fromPeer("p1", prompt);
  assert.deepEqual(delivered.map((msg) => msg.text), ["run this"]);

  // The same phone on a second connection gets a fresh session; the old frame is dead there too.
  const second = new SessionOffer(phone, server.publicKey);
  fromPeer("p2", second.message());
  second.accept(framesFor("p2")[0], peers);
  fromPeer("p2", prompt);
  assert.equal(delivered.length, 1);
});

test("the relay client still serves phones that predate session keys", () => {
  const { client, server, delivered, frames, fromPeer } = relayHarness();
  const phone = generateKeyPair();
  fromPeer("old", { type: "key_exchange", pubkey: toBase64(phone.publicKey) });
  assert.deepEqual(frames[0].data, { type: "key_exchange_ack", device: "approved" });

  fromPeer("old", encrypt(JSON.stringify({ type: "list_sessions" }), server.publicKey, phone.secretKey));
  assert.deepEqual(delivered.map((msg) => msg.type), ["list_sessions"]);
  client.send({ type: "text", content: "hi" });
  const reply = frames.at(-1);
  assert.equal(reply.peerId, "old");
  const envelope = { n: String(reply.data.n), c: String(reply.data.c) };
  assert.deepEqual(parseJsonObject(decrypt(envelope, server.publicKey, phone.secretKey)), { type: "text", content: "hi" });
});

test("the relay client drops a phone whose session offer was stripped and holds its key to them", () => {
  const { client, server, delivered, frames, fromPeer } = relayHarness();
  const phone = generateKeyPair();
  fromPeer("p1", { type: "key_exchange", pubkey: toBase64(phone.publicKey) });
  const sent = frames.length;
  fromPeer("p1", encrypt(JSON.stringify({ type: "client_capabilities", sessionKeyVersion: 1 }), server.publicKey, phone.secretKey));
  assert.equal(frames.length, sent, "no capabilities reply over the stripped channel");

  fromPeer("p1", encrypt(JSON.stringify({ type: "list_sessions" }), server.publicKey, phone.secretKey));
  assert.equal(delivered.length, 0);
  assert.equal(client.isKeyOnline(toBase64(phone.publicKey)), false);

  // A later stripped handshake from the same key is refused outright.
  fromPeer("p2", { type: "key_exchange", pubkey: toBase64(phone.publicKey) });
  assert.equal(frames.filter((frame) => frame.peerId === "p2").length, 0);
});

test("a computer link agrees a session with its target and cannot be replayed or downgraded", async () => {
  const { LinkConnection } = require("#server/computer-links");
  const { client: target, server, fromPeer } = relayHarness();
  /** @type {Array<Record<string, unknown>>} */
  const requests = [];
  target.opts.onPeerJson = (/** @type {Record<string, unknown>} */ msg) => { requests.push(msg); };
  target.opts.lane = "link";

  const linkPeers = new SessionKeyedPeerStore();
  const link = new LinkConnection({
    name: "Desktop", targetPubkey: toBase64(server.publicKey), relayUrl: "wss://relay.invalid", linkRoom: "room",
    ticket: "ticket", ticketExpiresAt: Date.now() + 60_000, access: { read: true, agents: false, commands: false }, confirm: "never",
  }, generateKeyPair(), { onEvent() {}, onOnline() {}, sessionKeyedPeers: linkPeers });
  /** @type {string[]} */
  const sent = [];
  let closed = false;
  link.ws = {
    readyState: 1,
    /** @param {string} data */
    send(data) { sent.push(data); fromPeer("l1", parseJsonObject(data)); },
    close() { closed = true; },
  };
  // The target's frames go straight back to the link.
  const targetSend = target.ws.send;
  target.ws.send = (/** @type {string} */ data) => {
    targetSend(data);
    link.handleFrame(parseJsonObject(String(parseJsonObject(data).data)));
  };

  link.handleFrame({ type: "peer_connected" });
  assert.equal(link.online, true);
  assert.equal(linkPeers.has(toBase64(server.publicKey)), true);

  const pending = link.request("list_sessions", {}, "chat-1", undefined, 200).catch(() => undefined);
  assert.equal(requests.length, 1);
  fromPeer("l1", parseJsonObject(sent.at(-1) ?? "{}"));
  assert.equal(requests.length, 1, "a replayed request is not handled twice");

  // Once the target has answered with a session, a static-box answer is refused.
  link.ws.send = () => {};
  link.handleFrame({ type: "peer_connected" });
  link.handleFrame({ type: "key_exchange_ack", device: "approved" });
  assert.equal(closed, true);
  assert.equal(link.online, false);
  link.close();
  await pending;
});
