const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");

const { handleCodexAppMcpRequest } = require("#server/codex-app-mcp");

test("/codex-mcp/ answers this computer only, and a proxy in front is not this computer", async (t) => {
  const server = http.createServer((req, res) => { void handleCodexAppMcpRequest(req, res); });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/codex-mcp/no-such-session`;

  // Past the loopback check, an unknown session is 404.
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 404);
  for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
    const response = await fetch(url, { method: "POST", body: "{}", headers: { [header]: "203.0.113.9" } });
    assert.equal(response.status, 403, header);
  }
});
