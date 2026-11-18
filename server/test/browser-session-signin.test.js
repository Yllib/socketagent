const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const { z } = require("zod");
const { BrowserSessionManager, resolveBrowserBinary } = require("#server/browser-session-manager");

function hasBrowser() {
  try {
    resolveBrowserBinary();
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths of the pages open in the Chrome running [profile], read from its
 * debugging port so windows the manager does not know about are counted.
 * @param {string} profile
 * @returns {Promise<string[]>}
 */
async function openPages(profile) {
  const line = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" }).split("\n")
    .find((entry) => entry.includes(`/${profile} `) && entry.includes("--user-data-dir=") && !entry.includes("--type="));
  const port = /--remote-debugging-port=(\d+)/.exec(line ?? "")?.[1];
  assert.ok(port, `no Chrome is running on ${profile}`);
  const targets = z.array(z.object({ type: z.string(), url: z.string() }))
    .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  return targets.filter((target) => target.type === "page").map((target) => new URL(target.url).pathname);
}

// Sites often sign in with a cookie that has no expiry date. Chrome deletes
// those when it starts unless it is restoring its last session.
test("a sign-in cookie with no expiry survives a browser restart, and old windows stay closed", {
  skip: process.platform === "win32" ? "Reads Chrome's port from ps" : !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 120_000,
}, async (t) => {
  /** @type {Map<string, string>} */
  const cookies = new Map();
  const server = http.createServer((request, response) => {
    cookies.set(request.url ?? "", request.headers.cookie ?? "");
    response.writeHead(200, {
      "Content-Type": "text/html",
      ...(request.url === "/sign-in" ? { "Set-Cookie": "signed-in=1; Path=/" } : {}),
    });
    response.end("<body><h1>page</h1></body>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const manager = new BrowserSessionManager();
  const profile = `test-signin-${crypto.randomBytes(4).toString("hex")}`;
  t.after(async () => {
    await manager.closeAll().catch(() => {});
    await manager.clear(profile).catch(() => {});
    server.close();
  });

  await manager.open(profile, `${origin}/sign-in`, { sessionId: "chat", reuse: true });
  await manager.open(profile, `${origin}/other`, { sessionId: "other", reuse: true });
  // What a server restart does: every Chrome quits with its windows open.
  await manager.closeAll();

  await manager.open(profile, `${origin}/after`, { sessionId: "chat", reuse: true });
  assert.equal(cookies.get("/after"), "signed-in=1");
  assert.equal(manager.active().length, 1);
  assert.deepEqual(await openPages(profile), ["/after"]);
});
