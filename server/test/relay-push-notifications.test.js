const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const nacl = require("tweetnacl");
// Keeps the push token store in a throwaway folder, away from this machine's own.
require("./test-data-dir");

const { generateKeyPair } = require("#server/noise-ikpsk1");
const {
  clearPushRegistrations,
  dropDeviceRegistrations,
  getPushDeliveryCapabilities,
  isPushConfigured,
  isPushTokenRegistered,
  registerPushToken,
  relayPushTokens,
  sendPushNotification,
  setPushTransport,
  shouldSendForwardedPush,
  unregisterPushToken,
} = require("#server/push-notifications");
const { RelayClient } = require("#server/relay-client");
const { saveSecureInput } = require("#server/secure-input-store");
const { derivePushKey, secretTag } = require("#server/transport-v2");
const { isRecord, parseJsonObject } = require("#server/value-guards");

const pushEnvironmentKeys = [
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_SERVICE_ACCOUNT_PATH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "RELAY_URL",
  "PAIRING_TOKEN",
  "SOCKETAGENT_TEST_MODE",
];

/** @param {()=>void | Promise<void>} run */
function withCleanPushEnvironment(run) {
  const previous = Object.fromEntries(
    pushEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of pushEnvironmentKeys) delete process.env[key];
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("headless forwarding never duplicates an FCM dispatch owned by NotifyUser", () => {
  assert.equal(shouldSendForwardedPush({
    type: "scheduled_task_notification",
    fcmDispatched: true,
  }), false);
  assert.equal(shouldSendForwardedPush({
    type: "scheduled_task_notification",
  }), true);
});

test("test mode cannot send a notification through inherited relay credentials", async () => {
  await withCleanPushEnvironment(async () => {
    process.env.SOCKETAGENT_TEST_MODE = "1";
    process.env.RELAY_URL = "wss://relay.jarofdirt.info";
    process.env.PAIRING_TOKEN = "inherited-production-token";
    assert.deepEqual(
      await sendPushNotification({ title: "Which target?" }),
      { sent: 0, attempted: 0 },
    );
  });
});

test("reports missing, invalid, and valid direct Firebase setup separately", async () => {
  await withCleanPushEnvironment(async () => {
    assert.deepEqual(getPushDeliveryCapabilities(), {
      directFcmConfigured: false,
      directFcmIssue: "missing",
      relayConfigured: false,
    });

    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "not-json";
    assert.equal(getPushDeliveryCapabilities().directFcmIssue, "invalid");

    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "socketagent-test",
      client_email: "firebase@example.test",
      private_key: "test-key",
    });
    assert.deepEqual(getPushDeliveryCapabilities(), {
      directFcmConfigured: true,
      directFcmProjectId: "socketagent-test",
      relayConfigured: false,
    });
  });
});

test("reports an explicit Firebase target project", async () => {
  await withCleanPushEnvironment(async () => {
    process.env.FIREBASE_PROJECT_ID = "socketagent-target";
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: "firebase@example.test",
      private_key: "test-key",
    });
    assert.deepEqual(getPushDeliveryCapabilities(), {
      directFcmConfigured: true,
      directFcmProjectId: "socketagent-target",
      relayConfigured: false,
    });
  });
});

test("reports unreadable Firebase credential files and relay availability", async () => {
  await withCleanPushEnvironment(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-push-"));
    try {
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(directory, "missing.json");
      process.env.RELAY_URL = "wss://relay.example.test";
      process.env.PAIRING_TOKEN = "pairing-secret";
      assert.deepEqual(getPushDeliveryCapabilities(), {
        directFcmConfigured: false,
        directFcmIssue: "unreadable",
        relayConfigured: true,
      });
      assert.equal(isPushConfigured(), true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * A relay client on a fake open socket. Frames it sends to the relay are captured.
 * @param {(() => import("#server/push-notifications").RelayPushToken[])} [pushTokens]
 */
function relayClient(pushTokens) {
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: "ab".repeat(32),
    keyPair: generateKeyPair(),
    onStatusChange: () => {},
    ...(pushTokens ? { pushTokens } : {}),
  });
  client.ws = { readyState: 1, send: (/** @type {string} */ data) => sent.push(parseJsonObject(data)), close: () => {} };
  /** @param {Record<string, unknown>} message */
  const fromRelay = (message) => client.handleRelayMessage(message);
  return { client, sent, fromRelay };
}

test("relay_push goes over the owned room socket and waits for its result", async (t) => {
  const { client, sent, fromRelay } = relayClient();
  await assert.rejects(client.relayPush({ sealed: "sealed-text" }), /relay socket is down/, "not before the relay accepts the owner key");
  assert.equal(sent.length, 0);

  fromRelay({ type: "relay_capabilities", multiDevice: true, owner: true });
  const push = client.relayPush({ sealed: "sealed-text", serverId: "phone-id" });
  assert.deepEqual(sent, [{ type: "relay_push", id: sent[0].id, sealed: "sealed-text", serverId: "phone-id" }]);
  assert.equal(typeof sent[0].id, "string");
  fromRelay({ type: "relay_push_result", id: "someone-else", sent: 9, attempted: 9 });
  fromRelay({ type: "relay_push_result", id: sent[0].id, sent: 2, attempted: 3 });
  assert.deepEqual(await push, { sent: 2, attempted: 3, dead: [] });

  // The tokens the relay names as dead come back with the counts. Anything that is not a string is left out.
  const withDead = client.relayPush({ sealed: "sealed-text" });
  fromRelay({ type: "relay_push_result", id: sent[1].id, sent: 1, attempted: 2, dead: ["fcm-dead", 7, null] });
  assert.deepEqual(await withDead, { sent: 1, attempted: 2, dead: ["fcm-dead"] });

  const refused = client.relayPush({ sealed: "sealed-text" });
  fromRelay({ type: "relay_push_result", id: sent[2].id, error: "invalid_push" });
  await assert.rejects(refused, /invalid_push/);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const unanswered = client.relayPush({ sealed: "sealed-text" });
  t.mock.timers.tick(9_999);
  const late = client.relayPush({ sealed: "sealed-text" });
  t.mock.timers.tick(1);
  await assert.rejects(unanswered, /did not answer in 10 s/);
  t.mock.timers.reset();

  client.close();
  await assert.rejects(late, /relay socket closed/);
  await assert.rejects(client.relayPush({ sealed: "sealed-text" }), /relay socket is down/);
});

test("a notification reaches the relay sealed, with plaintext only for a phone that registered on the old path", async () => {
  const secret = crypto.randomBytes(32);
  /** @type {import("#server/push-sealing").RelayPushRequest[]} */
  const pushes = [];
  let plaintextAllowed = false;
  let relayUp = true;
  setPushTransport({
    sealingSecrets: () => [secret],
    plaintextAllowed: () => plaintextAllowed,
    relayPush: (push) => {
      if (!relayUp) return Promise.reject(new Error("the relay socket is down"));
      pushes.push(push);
      return Promise.resolve({ sent: 1, attempted: 1, dead: [] });
    },
    relayTokensChanged: () => {},
  });
  try {
    await withCleanPushEnvironment(async () => {
      process.env.RELAY_URL = "wss://relay.example.test";
      process.env.PAIRING_TOKEN = "ab".repeat(32);
      const notification = { title: "Finished", body: "Final response text", sessionId: "session-1", kind: "session_finished" };

      assert.deepEqual(await sendPushNotification(notification), { sent: 1, attempted: 1 });
      assert.deepEqual(Object.keys(pushes[0]), ["sealed"], "no legacy part and nothing readable");
      const [tag, boxed] = pushes[0].sealed.split(".");
      assert.equal(tag, secretTag(secret));
      const bytes = Buffer.from(boxed, "base64");
      const opened = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), derivePushKey(secret));
      assert.ok(opened);
      assert.equal(parseJsonObject(Buffer.from(opened).toString("utf8")).body, "Final response text");

      // A device on the old path alone does not put plaintext in the push.
      plaintextAllowed = true;
      await sendPushNotification(notification);
      registerPushToken("fcm-new-app", "ios", "phone-b-id", "relay", undefined, true);
      await sendPushNotification(notification);
      assert.deepEqual([Object.keys(pushes[1]), Object.keys(pushes[2])], [["sealed"], ["sealed", "serverId"]]);

      // It takes a phone that registered on the old path, and it ends when that registration goes.
      registerPushToken("fcm-old-app", "android", "phone-a-id", "relay");
      await sendPushNotification(notification);
      assert.equal(isRecord(pushes[3].legacy) && pushes[3].legacy.title, "Finished");
      unregisterPushToken("fcm-old-app");
      await sendPushNotification(notification);
      assert.equal("legacy" in pushes[4], false);
      unregisterPushToken("fcm-new-app");

      // With the relay socket down the push is not sent, and nothing throws.
      relayUp = false;
      assert.deepEqual(await sendPushNotification(notification), { sent: 0, attempted: 0 });
      assert.equal(pushes.length, 5);
    });
  } finally {
    setPushTransport(null);
  }
});

test("a token the relay reports dead leaves this computer's store, so the next list does not put it back", async () => {
  /** @type {string[]} */
  let dead = [];
  let changes = 0;
  setPushTransport({
    sealingSecrets: () => [crypto.randomBytes(32)],
    plaintextAllowed: () => false,
    relayPush: () => Promise.resolve({ sent: 1, attempted: 2, dead }),
    relayTokensChanged: () => { changes += 1; },
  });
  try {
    await withCleanPushEnvironment(async () => {
      process.env.RELAY_URL = "wss://relay.example.test";
      process.env.PAIRING_TOKEN = "ab".repeat(32);
      registerPushToken("fcm-live", "android", "phone-a-id", "relay", undefined, true);
      registerPushToken("fcm-dead", "android", "phone-b-id", "relay", undefined, true);
      registerPushToken("fcm-direct", "android", "phone-c-id", "direct", "some-project");
      const stored = () => ["fcm-live", "fcm-dead", "fcm-direct"].filter((token) => isPushTokenRegistered(token));

      changes = 0;
      assert.deepEqual(await sendPushNotification({ title: "Finished" }), { sent: 1, attempted: 3 });
      assert.deepEqual(stored(), ["fcm-live", "fcm-dead", "fcm-direct"]);
      assert.equal(changes, 0, "nothing dead, nothing rewritten");

      // The relay may name only a token it delivers for. One this computer's own Firebase serves stays.
      dead = ["fcm-dead", "fcm-direct", "fcm-never-registered"];
      assert.deepEqual(await sendPushNotification({ title: "Finished" }), { sent: 1, attempted: 3 });
      assert.deepEqual(stored(), ["fcm-live", "fcm-direct"]);
      assert.deepEqual(relayPushTokens().map((entry) => entry.token), ["fcm-live"]);
      assert.equal(changes, 1, "the relay is sent the list without it");
    });
  } finally {
    clearPushRegistrations();
    setPushTransport(null);
  }
});

test("the relay gets the room's push list when it accepts the owner key and after every change, two seconds apart", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-13T10:00:00Z") });
  /** @type {import("#server/push-notifications").RelayPushToken[]} */
  let held = [{ token: "fcm-old-app", platform: "android", serverId: "phone-a-id" }];
  const { client, sent, fromRelay } = relayClient(() => held);

  client.sendPushTokens();
  fromRelay({ type: "relay_capabilities", multiDevice: true });
  assert.equal(sent.length, 0, "not to a relay that has not accepted this computer as the room's owner");

  fromRelay({ type: "relay_capabilities", multiDevice: true, owner: true });
  assert.deepEqual(sent, [{ type: "relay_push_tokens", id: sent[0].id, tokens: held }]);
  assert.equal(typeof sent[0].id, "string");

  // Changes inside two seconds of the last frame go out as one frame when the two seconds are up, with the newest list.
  held = [...held, { token: "fcm-new-app", platform: "ios", serverId: "phone-b-id", v: 2 }];
  client.sendPushTokens();
  held = [...held, { token: "fcm-third", platform: "android" }];
  client.sendPushTokens();
  t.mock.timers.tick(1_999);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].tokens, held);
  fromRelay({ type: "relay_push_tokens_result", id: sent[1].id, count: 3 });

  // Two seconds after the last frame the next change goes at once.
  t.mock.timers.tick(2_000);
  client.sendPushTokens();
  assert.equal(sent.length, 3);

  // A removal or a reset does not wait, and takes the place of a frame that was waiting.
  client.sendPushTokens();
  held = [];
  client.sendPushTokens(true);
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[3].tokens, []);
  t.mock.timers.tick(2_000);
  assert.equal(sent.length, 4);

  // A frame still waiting when the socket closes is not sent, and the next socket starts with no wait.
  client.sendPushTokens(true);
  client.sendPushTokens();
  client.close();
  t.mock.timers.tick(2_000);
  client.sendPushTokens();
  assert.equal(sent.length, 5, "nothing once the socket is gone");

  // A room that keeps no push list, like the bulk room, sends none.
  const bulk = relayClient();
  bulk.fromRelay({ type: "relay_capabilities", multiDevice: true, owner: true });
  bulk.client.sendPushTokens();
  assert.equal(bulk.sent.length, 0);
});

test("every registration an app gives this computer is on the list for the relay, and each change is announced", () => {
  let changes = 0;
  setPushTransport({
    sealingSecrets: () => [],
    plaintextAllowed: () => false,
    relayPush: () => Promise.reject(new Error("unused")),
    relayTokensChanged: () => { changes += 1; },
  });
  try {
    // A released app on the old path, the new app on a v2 channel, and a phone this computer's own Firebase serves.
    registerPushToken("fcm-old-app", "android", "phone-a-id", "relay");
    registerPushToken("fcm-new-app", "ios", "phone-b-id", "relay", undefined, true);
    registerPushToken("fcm-direct", "android", "phone-c-id", "direct", "some-project");
    registerPushToken("fcm-no-route", "android");
    assert.equal(changes, 4);
    assert.deepEqual(relayPushTokens(), [
      { token: "fcm-old-app", platform: "android", serverId: "phone-a-id" },
      { token: "fcm-new-app", platform: "ios", serverId: "phone-b-id", v: 2 },
      { token: "fcm-no-route", platform: "android" },
    ]);

    unregisterPushToken("fcm-old-app", "phone-a-id");
    assert.equal(changes, 5);
    assert.deepEqual(relayPushTokens().map((entry) => entry.token), ["fcm-new-app", "fcm-no-route"]);
  } finally {
    for (const token of ["fcm-new-app", "fcm-direct", "fcm-no-route"]) unregisterPushToken(token);
    setPushTransport(null);
  }
});

test("a removed device's registrations leave the list for the relay, and a reset leaves none", () => {
  let changes = 0;
  /** @type {boolean[]} */
  const atOnce = [];
  setPushTransport({
    sealingSecrets: () => [],
    plaintextAllowed: () => false,
    relayPush: () => Promise.reject(new Error("unused")),
    relayTokensChanged: (now) => { changes += 1; atOnce.push(now); },
  });
  const listed = () => relayPushTokens().map((entry) => entry.token);
  try {
    registerPushToken("fcm-lost-phone", "android", "phone-a-id", "relay", undefined, true, "key-lost");
    registerPushToken("fcm-kept-phone", "android", "phone-b-id", "relay", undefined, true, "key-kept");
    // Stored before keys were kept, or sent over the loopback token socket.
    registerPushToken("fcm-no-key", "android", "phone-c-id", "relay");
    registerPushToken("fcm-no-key-2", "android", "phone-d-id", "relay");

    // A phone that registers again under a key takes that key. One that registers again without one keeps it.
    registerPushToken("fcm-no-key-2", "android", "phone-d-id", "relay", undefined, true, "key-kept");
    registerPushToken("fcm-lost-phone", "android", "phone-a-id", "relay", undefined, true);
    assert.deepEqual(listed(), ["fcm-kept-phone", "fcm-no-key", "fcm-no-key-2", "fcm-lost-phone"]);
    assert.equal(atOnce.includes(true), false, "a registration waits its turn");

    // Forget: the forgotten key's registrations only.
    changes = 0;
    dropDeviceRegistrations("key-lost", false);
    assert.deepEqual(listed(), ["fcm-kept-phone", "fcm-no-key", "fcm-no-key-2"]);
    assert.equal(changes, 1, "the relay is sent the new list");
    assert.equal(atOnce.at(-1), true, "and without waiting");
    dropDeviceRegistrations("key-lost", false);
    assert.equal(changes, 1, "nothing to drop, nothing to send");

    // Remove: also every registration under no key, since the removed phone's may be one of them.
    registerPushToken("fcm-lost-phone", "android", "phone-a-id", "relay", undefined, true, "key-lost");
    dropDeviceRegistrations("key-lost", true);
    assert.deepEqual(listed(), ["fcm-kept-phone", "fcm-no-key-2"]);

    // pair --reset: nobody stays registered.
    changes = 0;
    clearPushRegistrations();
    assert.deepEqual(listed(), []);
    assert.equal(changes, 1);
    assert.equal(atOnce.at(-1), true);
  } finally {
    clearPushRegistrations();
    setPushTransport(null);
  }
});

test("a secret the agent repeats is taken out of the notification before it leaves", async () => {
  const secret = crypto.randomBytes(32);
  /** @type {import("#server/push-sealing").RelayPushRequest[]} */
  const pushes = [];
  saveSecureInput({ label: "PUSH_TOKEN", value: "push-secret-must-not-leak", scope: "global" });
  setPushTransport({
    sealingSecrets: () => [secret],
    plaintextAllowed: () => false,
    relayPush: (push) => {
      pushes.push(push);
      return Promise.resolve({ sent: 1, attempted: 1, dead: [] });
    },
    relayTokensChanged: () => {},
  });
  try {
    await withCleanPushEnvironment(async () => {
      process.env.RELAY_URL = "wss://relay.example.test";
      process.env.PAIRING_TOKEN = "ab".repeat(32);
      await sendPushNotification({
        title: "Key push-secret-must-not-leak",
        body: "I used push-secret-must-not-leak to log in",
        data: { summary: "push-secret-must-not-leak" },
      });
      const bytes = Buffer.from(pushes[0].sealed.split(".")[1], "base64");
      const opened = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), derivePushKey(secret));
      assert.ok(opened);
      const text = Buffer.from(opened).toString("utf8");
      assert.equal(text.includes("push-secret-must-not-leak"), false);
      assert.match(parseJsonObject(text).body, /^I used .+ to log in$/);
    });
  } finally {
    setPushTransport(null);
  }
});
