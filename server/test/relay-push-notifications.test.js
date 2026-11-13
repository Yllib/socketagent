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
  getPushDeliveryCapabilities,
  isPushConfigured,
  sendPushNotification,
  setPushTransport,
  shouldSendForwardedPush,
} = require("#server/push-notifications");
const { RelayClient } = require("#server/relay-client");
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

/** A relay client on a fake open socket. Frames it sends to the relay are captured. */
function relayClient() {
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  const client = new RelayClient({
    relayUrl: "wss://relay.invalid",
    pairingToken: "ab".repeat(32),
    keyPair: generateKeyPair(),
    onStatusChange: () => {},
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
  assert.deepEqual(await push, { sent: 2, attempted: 3 });

  const refused = client.relayPush({ sealed: "sealed-text" });
  fromRelay({ type: "relay_push_result", id: sent[1].id, error: "invalid_push" });
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

test("a notification reaches the relay sealed, with plaintext only while a device is on the old path", async () => {
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
      return Promise.resolve({ sent: 1, attempted: 1 });
    },
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

      plaintextAllowed = true;
      await sendPushNotification(notification);
      assert.equal(isRecord(pushes[1].legacy) && pushes[1].legacy.title, "Finished");

      // With the relay socket down the push is not sent, and nothing throws.
      relayUp = false;
      assert.deepEqual(await sendPushNotification(notification), { sent: 0, attempted: 0 });
      assert.equal(pushes.length, 2);
    });
  } finally {
    setPushTransport(null);
  }
});
