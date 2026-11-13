const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const nacl = require("tweetnacl");
const dataDir = require("./test-data-dir");

const { DeviceAuthGate } = require("#server/device-auth");
const { DeviceRegistry } = require("#server/device-registry");
const { generateKeyPair } = require("#server/noise-ikpsk1");
const { BULK_RELAY_PAIRING_SUFFIX } = require("#server/protocol");
const { RelayClient } = require("#server/relay-client");
const { SessionKeyedPeerStore } = require("#server/relay-crypto");
const { relayClientOptions } = require("#server/relay-lanes");
const { TransportResponder } = require("#server/transport-responder");
const { dial } = require("./v2-initiator");

// The relay clients of the control, bulk and link rooms, built the way
// index.ts builds them. A lane that was left without a responder answers no
// v2 handshake, which once left every link with a secret unable to connect.

const ROOM_ID = "ab".repeat(32);
const LINK_ROOM_ID = "cd".repeat(32);

test("every lane index.ts builds answers a v2 handshake", () => {
  const registry = new DeviceRegistry(path.join(dataDir, "relay-lanes.json"));
  const serverKeys = generateKeyPair();
  const responder = new TransportResponder({ registry, keyPair: () => serverKeys, roomId: () => ROOM_ID, linkRoomId: () => LINK_ROOM_ID, serverVersion: "1.1.530" });
  const lane = (/** @type {string} */ pairingToken) => ({ pairingToken, onStatusChange: () => {} });
  const options = relayClientOptions(
    {
      relayUrl: "wss://relay.invalid",
      keyPair: serverKeys,
      ownerKey: nacl.sign.keyPair(),
      responder,
      legacyTransport: true,
      peerAuth: new DeviceAuthGate(registry, () => "token"),
      sessionKeyedPeers: new SessionKeyedPeerStore(),
    },
    { control: lane(ROOM_ID), bulk: lane(`${ROOM_ID}${BULK_RELAY_PAIRING_SUFFIX}`), link: lane(LINK_ROOM_ID) },
  );
  assert.ok(options.link);

  // A recorded device for the device lanes, and a linked computer with a link secret.
  const phone = generateKeyPair();
  registry.enroll({ publicKey: Buffer.from(phone.publicKey).toString("base64"), kind: "device", name: "Pixel 9", platform: "android", via: "token", transport: 2 });
  const computer = generateKeyPair();
  const linkSecret = Buffer.alloc(32, 9).toString("base64");
  registry.enroll({
    publicKey: Buffer.from(computer.publicKey).toString("base64"), kind: "computer", name: "Dev VM", platform: "computer", via: "link",
    access: { read: true, agents: false, commands: false }, confirm: "never", linkSecret,
  });
  const pairingSecret = registry.currentSecret().secret;
  const dials = {
    control: dial({ serverKey: serverKeys.publicKey, secret: pairingSecret, roomId: ROOM_ID, lane: "control", keys: phone }),
    bulk: dial({ serverKey: serverKeys.publicKey, secret: pairingSecret, roomId: ROOM_ID, lane: "bulk", keys: phone }),
    link: dial({ serverKey: serverKeys.publicKey, secret: linkSecret, roomId: LINK_ROOM_ID, lane: "link", keys: computer, payload: { app: "1.1.530" } }),
  };

  for (const name of /** @type {const} */ (["control", "bulk", "link"])) {
    const laneOptions = options[name];
    assert.ok(laneOptions);
    assert.equal(laneOptions.lane, name);
    const client = new RelayClient(laneOptions);
    /** @type {string[]} */
    const frames = [];
    client.sendRawFrameToPeer = (_peerId, data) => { frames.push(String(data)); };
    client.ws = { readyState: 1 };
    client.handleRelayMessage({ type: "relay_peer_message", peerId: "peer-1", binary: false, data: dials[name].hs1 });
    assert.equal(frames.length, 1, `${name}: hs1 is answered`);
    assert.equal(dials[name].finish(frames[0]).answer.status, "open", name);
  }
});
