const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handlePrivateIntegrationAuthTool,
} = require("#server/app-tool-handlers");
const {
  startPrivateIntegrationAuthorization,
} = require("#server/private-integration-auth");

/** @param {Partial<import("#server/app-tool-handlers").AppToolContext>} [overrides] @returns {import("#server/app-tool-handlers").AppToolContext} */
function context(overrides = {}) {
  return {
    getSessionId: () => "session-1",
    send: () => {},
    getTtsEngine: () => "system",
    getKokoroVoice: () => "",
    getKokoroSpeed: () => 1,
    ...overrides,
  };
}

test("private-integration authorization delegates to the owning session plugin", async () => {
  /** @type {string[]} */
  const calls = [];
  const result = await handlePrivateIntegrationAuthTool(
    context({
      requestPluginAuthorization: async (name) => {
        calls.push(name);
        return true;
      },
    }),
    "outlook-auth",
  );

  assert.deepEqual(calls, ["outlook-auth"]);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /completed/);
});

test("private-integration authorization fails closed when unavailable", async () => {
  const result = await handlePrivateIntegrationAuthTool(
    context(),
    "ibs-auth",
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unavailable/);
});

test("settings can start private integration auth without a session", async () => {
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  startPrivateIntegrationAuthorization({
    plugins: [{
      name: "outlook-auth",
      requestAuthorization(ctx) {
        assert.equal(ctx.sessionId, "");
        ctx.send({
          type: "outlook_auth",
          authRequestId: "outlook_auth_direct",
          sessionId: "",
          startUrl: "https://mail.example.test/inbox",
          captureOrigins: ["https://mail.example.test"],
        });
        return new Promise(() => {});
      },
    }],
    integration: "outlook-auth",
    requestId: "settings-request-1",
    cwd: "/tmp",
    send: (message) => sent.push(message),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "outlook_auth");
  assert.equal(sent[0].directRequestId, "settings-request-1");
  assert.equal(sent[0].sessionId, "");
});

test("settings auth reports an unavailable integration", () => {
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  startPrivateIntegrationAuthorization({
    plugins: [],
    integration: "ibs-auth",
    requestId: "settings-request-2",
    cwd: "/tmp",
    send: (message) => sent.push(message),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "private_integration_auth_result");
  assert.equal(sent[0].started, false);
  assert.equal(typeof sent[0].error, "string");
  if (typeof sent[0].error !== "string") assert.fail("Missing error text");
  assert.match(sent[0].error, /not available/);
});
