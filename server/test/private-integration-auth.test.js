const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handlePrivateIntegrationAuthTool,
} = require("../dist/app-tool-handlers");
const {
  SOCKETAGENT_APP_TOOLS,
} = require("../dist/codex-app-mcp");

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

test("Codex advertises protected private-integration authorization", () => {
  assert.ok(
    SOCKETAGENT_APP_TOOLS.some((tool) => tool.name === "PrivateIntegrationAuth"),
  );
});

test("private-integration authorization delegates to the owning session plugin", async () => {
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
