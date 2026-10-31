const { parseServerMessage } = require("#server/server-message");
const assert = require("node:assert/strict"), test = require("node:test"), crypto = require("node:crypto");
require("./test-data-dir");
const { CodexSession, codexMcpConnectionState, codexMcpStatusEntry } = require("#server/codex-session");

/** @type {CodexSession[]} */
const sessions = [];
test.afterEach(() => { for (const s of sessions.splice(0)) {
  clearTimeout(s.appServerIdleStopTimer);
  clearTimeout(s.pendingAppServerTurnCompletion);
} });

/** @returns {import("#server/generated/codex/types/v2/McpServerStatus").McpServerStatus} */
function server(/** @type {Partial<import("#server/generated/codex/types/v2/McpServerStatus").McpServerStatus>} */ overrides) {
  return {
    name: "linear", runtimeStatus: null, pluginId: null, httpOrigin: "https://mcp.linear.app", serverInfo: null,
    serverCapabilities: null, toolListMeta: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [],
    authStatus: "unsupported", ...overrides,
  };
}

test("Codex runtime and auth states fold into the app's connection states", () => {
  assert.equal(codexMcpConnectionState(server({ authStatus: "notLoggedIn" })), "needs-auth");
  assert.equal(codexMcpConnectionState(server({ runtimeStatus: "authenticationRequired", authStatus: "oAuth" })), "needs-auth");
  assert.equal(codexMcpConnectionState(server({ runtimeStatus: "connected", authStatus: "bearerToken" })), "connected");
  assert.equal(codexMcpConnectionState(server({ runtimeStatus: "starting" })), "pending");
  assert.equal(codexMcpConnectionState(server({ runtimeStatus: "cancelled" })), "failed");
  assert.equal(codexMcpConnectionState(server({ runtimeStatus: "disabled" })), "disabled");
  // No thread yet: Codex dialed the server to list tools, so the error decides.
  assert.equal(codexMcpConnectionState(server({ toolsError: "MCP startup failed" })), "failed");
  assert.equal(codexMcpConnectionState(server({ tools: { search: { name: "search", inputSchema: {} } } })), "connected");

  const entry = codexMcpStatusEntry(server({ authStatus: "notLoggedIn", toolsError: "Auth required" }));
  assert.equal(entry.status, "needs-auth");
  assert.equal(entry.signIn, true);
  assert.equal(entry.toggleable, false);
  assert.equal(entry.error, "Auth required");
  assert.equal(codexMcpStatusEntry(server({ runtimeStatus: "connected", authStatus: "bearerToken" })).signIn, false);
  assert.equal(codexMcpStatusEntry(server({ runtimeStatus: "authenticationRequired", authStatus: "oAuth" })).signIn, true);
  assert.equal(codexMcpStatusEntry(server({ runtimeStatus: "disabled" })).enabled, false);
});

function fixture() {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const s = new CodexSession({ readyState: 1, send: (/** @type {string} */ v) => sent.push(parseServerMessage(JSON.parse(v))) }, "/tmp");
  sessions.push(s);
  s.sessionId = s.threadId = `mcp-login-${crypto.randomUUID()}`;
  /** @type {{ method: string; params: unknown }[]} */
  const requests = [];
  let signedIn = false;
  s.appServer = {
    request: async (/** @type {string} */ method, /** @type {Record<string, unknown> | undefined} */ params) => {
      requests.push({ method, params });
      if (method === "mcpServerStatus/list") {
        return params?.cursor === "page-2"
          ? { data: [server({ name: "docs", runtimeStatus: "connected", authStatus: "unsupported" })], nextCursor: null }
          : { data: [server(signedIn ? { runtimeStatus: "connected", authStatus: "oAuth" } : { runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn" })], nextCursor: "page-2" };
      }
      if (method === "mcpServer/oauth/login") return { authorizationUrl: "https://mcp.linear.app/authorize?state=abc", loginId: "login-1" };
      if (method === "config/mcpServer/reload") { signedIn = true; return {}; }
      throw new Error(`unexpected ${method}`);
    },
    stop: async () => {},
    removeAllListeners: () => {},
  };
  s.appServerInitialized = true;
  return { s, sent, requests };
}

test("status pages fold into one list scoped to the session's thread", async () => {
  const f = fixture();
  const servers = await f.s.mcpServerStatus();
  assert.deepEqual(servers.map((entry) => [entry.name, entry.status, entry.signIn]), [["linear", "needs-auth", true], ["docs", "connected", false]]);
  const listCalls = f.requests.filter((request) => request.method === "mcpServerStatus/list");
  assert.equal(listCalls.length, 2);
  assert.equal(/** @type {Record<string, unknown>} */ (listCalls[0].params).threadId, f.s.threadId);
});

test("a sign-in hands the app the URL, then the outcome and a fresh status", async () => {
  const f = fixture();
  f.s.surfacedMcpAuth.add("linear");
  await f.s.loginMcpServer("linear");
  const login = f.requests.find((request) => request.method === "mcpServer/oauth/login");
  assert.deepEqual(login?.params, { name: "linear", threadId: f.s.threadId });
  assert.deepEqual(f.sent.at(-1), {
    type: "mcp_login_started", serverName: "linear", loginId: "login-1",
    url: "https://mcp.linear.app/authorize?state=abc", sessionId: f.s.sessionId,
  });

  f.s.handleAppServerNotification("mcpServer/oauthLogin/completed", { name: "linear", threadId: f.s.threadId, loginId: "login-1", success: false, error: "timed out waiting for OAuth callback" });
  assert.deepEqual(f.sent.filter((m) => m.type === "mcp_login_result").at(-1), {
    type: "mcp_login_result", serverName: "linear", loginId: "login-1", success: false,
    error: "timed out waiting for OAuth callback", sessionId: f.s.sessionId,
  });
  assert.ok(f.s.surfacedMcpAuth.has("linear"), "a failed sign-in keeps the auth card suppressed");

  f.s.handleAppServerNotification("mcpServer/oauthLogin/completed", { name: "linear", threadId: f.s.threadId, loginId: "login-1", success: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.sent.filter((m) => m.type === "mcp_login_result").at(-1)?.success, true);
  assert.ok(!f.s.surfacedMcpAuth.has("linear"), "success lets the next auth failure surface again");
  assert.ok(f.requests.some((request) => request.method === "config/mcpServer/reload"));
  const status = f.sent.filter((m) => m.type === "mcp_status").at(-1);
  assert.equal(status?.type, "mcp_status");
  assert.deepEqual(status?.servers.map((entry) => [entry.name, entry.status]), [["linear", "connected"], ["docs", "connected"]]);
});

test("reconnect reloads the MCP config and toggling is refused", async () => {
  const f = fixture();
  assert.deepEqual(await f.s.reconnectMcpServer("linear"), { success: true });
  assert.ok(f.requests.some((request) => request.method === "config/mcpServer/reload"));
  await assert.rejects(f.s.toggleMcpServer("linear", false), /config\.toml/);
});
