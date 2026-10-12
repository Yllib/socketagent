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

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));

test("windows share a profile's Chrome, and save as and switch move one window", {
  skip: !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 120_000,
}, async (t) => {
  // Records the cookie header of every page request. /set signs the visitor in.
  /** @type {string[]} */
  const cookies = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    cookies.push(request.headers.cookie ?? "");
    response.writeHead(200, {
      "Content-Type": "text/html",
      ...(request.url === "/set" ? { "Set-Cookie": "signed=in; Max-Age=3600; Path=/" } : {}),
    });
    response.end("<body><h1>page</h1></body>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const manager = new BrowserSessionManager();
  const suffix = crypto.randomBytes(4).toString("hex");
  const profile = `test-windows-${suffix}`;
  const saved = `test-saved-${suffix}`;
  const other = `test-other-${suffix}`;
  /** @type {Map<string, number>} */
  const frames = new Map();
  const unsubscribe = manager.onFrame((frame) => frames.set(frame.profile, (frames.get(frame.profile) ?? 0) + 1));
  t.after(async () => {
    unsubscribe();
    await manager.closeAll().catch(() => {});
    for (const name of [profile, saved, other]) await manager.clear(name).catch(() => {});
    server.close();
  });

  const first = await manager.open(profile, `${origin}/set`);
  const second = await manager.open(profile, `${origin}/`);
  assert.equal(first.profile, profile);
  assert.equal(second.profile, `${profile}~2`);
  assert.deepEqual(
    manager.active().map((browser) => [browser.profile, browser.browserProfile]).sort(),
    [[profile, profile], [`${profile}~2`, profile]],
  );
  assert.deepEqual(manager.list().filter((summary) => summary.profile === profile).map((summary) => summary.running), [true]);
  // The second window shares the first one's cookie jar.
  assert.match(cookies[cookies.length - 1], /signed=in/);

  // Both windows stream at once, though only one can be in front.
  await manager.watch(first.profile);
  await manager.watch(second.profile);
  for (let attempt = 0; attempt < 100 && !(frames.get(first.profile) && frames.get(second.profile)); attempt++) await sleep(50);
  assert.ok(frames.get(first.profile), "the first window sent no frames");
  assert.ok(frames.get(second.profile), "the second window sent no frames");

  // Save as copies the sign-in and moves only the saving window.
  const moved = await manager.saveProfileAs(second.profile, saved);
  assert.equal(moved.profile, second.profile);
  assert.equal(moved.browserProfile, saved);
  assert.equal((await manager.status(first.profile)).browserProfile, profile);
  cookies.length = 0;
  await manager.navigate(second.profile, `${origin}/after-save`);
  for (let attempt = 0; attempt < 100 && !cookies.length; attempt++) await sleep(50);
  assert.match(cookies[0] ?? "", /signed=in/);

  // Switching the last window off a profile stops that profile's Chrome.
  const switched = await manager.switchProfile(first.profile, other);
  assert.equal(switched.browserProfile, other);
  assert.deepEqual(manager.list().filter((summary) => summary.profile === profile).map((summary) => summary.running), [false]);

  // Closing one window leaves the others running.
  await manager.close(second.profile);
  assert.deepEqual(manager.active().map((browser) => browser.profile), [first.profile]);
});
