const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { isPushConfigured, sendPushNotification } = require("../dist/push-notifications");

test("routes authoritative FCM payloads through the configured relay", async () => {
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, sent: 1, attempted: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const oldRelay = process.env.RELAY_URL;
  const oldPairing = process.env.PAIRING_TOKEN;
  process.env.RELAY_URL = `ws://127.0.0.1:${address.port}`;
  process.env.PAIRING_TOKEN = "pairing-secret";

  try {
    assert.equal(isPushConfigured(), true);
    const result = await sendPushNotification({
      title: "Finished",
      body: "Final response text",
      sessionId: "session-1",
      status: "completed",
      kind: "session_finished",
      showNotification: false,
      data: { finishedAt: "2026-07-18T13:00:00.000Z" },
    });
    assert.deepEqual(result, { sent: 1, attempted: 1 });
    assert.equal(received.pairingToken, "pairing-secret");
    assert.equal(received.kind, "session_finished");
    assert.equal(received.showNotification, false);
    assert.equal(received.data.finishedAt, "2026-07-18T13:00:00.000Z");
  } finally {
    if (oldRelay === undefined) delete process.env.RELAY_URL;
    else process.env.RELAY_URL = oldRelay;
    if (oldPairing === undefined) delete process.env.PAIRING_TOKEN;
    else process.env.PAIRING_TOKEN = oldPairing;
    await new Promise((resolve) => server.close(resolve));
  }
});
