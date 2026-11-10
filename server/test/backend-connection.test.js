const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ConnectionFailureReporter,
  connectionFailureMessage,
  diagnoseBackendConnection,
  isBackendConnectionError,
} = require("../dist/backend-connection.js");

/**
 * A probe where every check passes except the named ones.
 * @param {{ network?: boolean, fail?: Partial<Record<"resolve" | "connect" | "handshake", string>> }} [options]
 * @returns {import("../dist/backend-connection.js").ConnectionProbe}
 */
function probe({ network = true, fail = {} } = {}) {
  /** @param {"resolve" | "connect" | "handshake"} step */
  const check = (step) => () => (step in fail ? Promise.reject(new Error(fail[step])) : Promise.resolve());
  return { hasNetwork: () => network, resolve: check("resolve"), connect: check("connect"), handshake: check("handshake") };
}

test("recognizes the errors a lost connection produces, and not refusals", () => {
  for (const message of [
    "Codex: workspace routing discovery failed",
    "Falling back from WebSockets to HTTPS transport. workspace routing discovery failed",
    "Codex couldn't start the codex_apps MCP server at https://chatgpt.com/backend-api/ps/mcp: the request couldn't reach it. This session continues without its tools.",
    "API Error: Connection refused (ECONNREFUSED)",
    "getaddrinfo ENOTFOUND api.anthropic.com",
  ]) {
    assert.equal(isBackendConnectionError(message), true, message);
  }
  for (const message of [
    "Your OpenAI sign-in has expired.",
    "You've hit your usage limit.",
    "Codex couldn't start the docs MCP server: its command couldn't be found. This session continues without its tools.",
  ]) {
    assert.equal(isBackendConnectionError(message), false, message);
  }
});

test("names the first hop that fails", async () => {
  /** @param {Parameters<typeof probe>[0]} [options] */
  const diagnose = (options) => diagnoseBackendConnection("codex", probe(options), {});
  assert.deepEqual(await diagnose({ network: false }), { cause: "offline" });
  assert.deepEqual(await diagnose({ fail: { resolve: "ENOTFOUND" } }), { cause: "dns" });
  assert.deepEqual(await diagnose({ fail: { connect: "ECONNREFUSED" } }), { cause: "blocked" });
  assert.deepEqual(await diagnose({ fail: { handshake: "Contoso Web Filter" } }), {
    cause: "intercepted",
    detail: "Contoso Web Filter",
  });
  assert.deepEqual(await diagnose({ fail: { handshake: "" } }), { cause: "blocked" });
  assert.deepEqual(await diagnose(), { cause: "reachable" });
});

test("with a proxy set, the proxy is the hop that counts", async () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:9" };
  assert.deepEqual(
    await diagnoseBackendConnection("claude", probe({ fail: { connect: "ECONNREFUSED" } }), env),
    { cause: "proxy", detail: "HTTPS_PROXY" },
  );
  // The provider's own DNS is the proxy's job, so a local lookup failure says nothing.
  assert.deepEqual(
    await diagnoseBackendConnection("claude", probe({ fail: { resolve: "ENOTFOUND" } }), env),
    { cause: "reachable" },
  );
});

test("the card says what is wrong and what happens next", () => {
  assert.equal(
    connectionFailureMessage("codex", { cause: "offline" }),
    "Codex can't reach OpenAI. This computer is not connected to a network. Send your message again once it is fixed.",
  );
  assert.equal(
    connectionFailureMessage("claude", { cause: "dns" }, { retrying: true, env: {} }),
    "Claude can't reach Anthropic. This computer can't look up api.anthropic.com, so its internet connection or DNS is down. Claude keeps retrying for a few minutes.",
  );
});

test("a burst of errors in one turn shows one card", async () => {
  /** @type {string[]} */
  const cards = [];
  const reporter = new ConnectionFailureReporter("codex", (message) => cards.push(message), async () => ({ cause: "offline" }));
  assert.deepEqual(await Promise.all([reporter.report(), reporter.report(), reporter.report()]), [true, true, true]);
  assert.equal(cards.length, 1);
  reporter.reset();
  assert.equal(await reporter.report(), true);
  assert.equal(cards.length, 2);
});

test("a computer that can reach the provider keeps the original errors", async () => {
  /** @type {string[]} */
  const cards = [];
  const reporter = new ConnectionFailureReporter("codex", (message) => cards.push(message), async () => ({ cause: "reachable" }));
  assert.equal(await reporter.report(), false);
  assert.deepEqual(cards, []);
});
