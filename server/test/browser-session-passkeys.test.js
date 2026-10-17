const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const { BrowserSessionManager, resolveBrowserBinary } = require("#server/browser-session-manager");

function hasBrowser() {
  try {
    resolveBrowserBinary();
    return true;
  } catch {
    return false;
  }
}

// Each request allows a minute, so an answer inside the test's wait means the
// browser refused it rather than waiting on a window nobody can see.
const PAGE = `<body><pre id="log"></pre><script>
  const log = (line) => { document.getElementById("log").textContent += line + "\\n"; };
  const challenge = new Uint8Array(32);
  // Chrome takes one request at a time, so the second waits for the first.
  const settle = (name, request) => request.then(() => log(name + " resolved"), (error) => log(name + " rejected " + error.name));
  settle("get", navigator.credentials.get({ publicKey: { challenge, timeout: 60000, userVerification: "preferred" } }))
    .then(() => settle("create", navigator.credentials.create({ publicKey: {
      challenge,
      timeout: 60000,
      rp: { name: "Test" },
      user: { id: new Uint8Array(8), name: "ann", displayName: "Ann" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
    } })));
</script></body>`;

test("passkey sign-in and registration fail at once instead of opening Chrome's hidden window", {
  skip: !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 60_000,
}, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manager = new BrowserSessionManager();
  const profile = `test-passkeys-${crypto.randomBytes(4).toString("hex")}`;
  t.after(async () => {
    await manager.clear(profile).catch(() => {});
    server.close();
  });
  // WebAuthn needs a secure context with a domain, which localhost is.
  await manager.open(profile, `http://localhost:${address.port}/`);

  let text = "";
  for (let attempt = 0; attempt < 50 && !text.includes("create "); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = (await manager.snapshot(profile)).text;
  }
  assert.match(text, /get rejected/);
  assert.match(text, /create rejected/);
});
