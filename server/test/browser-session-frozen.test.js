const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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

/**
 * The main Chrome process running [profile], which is the one without a
 * --type argument.
 * @param {string} profile
 * @returns {number}
 */
function chromePid(profile) {
  const line = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n")
    .find((entry) => entry.includes(`/${profile} `) && entry.includes("--user-data-dir=") && !entry.includes("--type="));
  assert.ok(line, `no Chrome is running on ${profile}`);
  return Number(line.trim().split(/\s+/)[0]);
}

/** @param {number} pid */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGSTOP freezes Chrome the way a stuck main thread does: the process and its
// debugging port stay, and nothing answers.
test("a Chrome that stops answering is reported, fails at once, and is replaced or killed", {
  skip: process.platform === "win32" ? "Needs SIGSTOP" : !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 120_000,
}, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<body><h1>page</h1></body>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const manager = new BrowserSessionManager();
  const profile = `test-frozen-${crypto.randomBytes(4).toString("hex")}`;
  /** @type {number[]} */
  const stopped = [];
  t.after(async () => {
    // A stopped process that survived a failed assertion would never exit.
    for (const pid of stopped) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await manager.closeAll().catch(() => {});
    await manager.clear(profile).catch(() => {});
    server.close();
  });
  /** @param {string} id */
  const responding = (id) => manager.active().find((browser) => browser.profile === id)?.responding;

  const first = await manager.open(profile, origin, { sessionId: "chat", reuse: true });
  const firstPid = chromePid(profile);
  stopped.push(firstPid);
  process.kill(firstPid, "SIGSTOP");

  // The command in flight learns of it well before its 20 second timeout.
  let started = Date.now();
  await assert.rejects(manager.navigate(first.profile, `${origin}/next`), /stopped responding/);
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  started = Date.now();
  await assert.rejects(manager.snapshot(first.profile), /stopped responding/);
  assert.ok(Date.now() - started < 1_000, "a later command did not fail at once");
  assert.equal(responding(first.profile), false);

  // Opening the profile again starts a new Chrome in place of the stuck one.
  const reopened = await manager.open(profile, origin, { sessionId: "chat", reuse: true });
  assert.equal(isRunning(firstPid), false, "the stuck Chrome was left running");
  assert.equal(reopened.responding, undefined);
  assert.match((await manager.snapshot(reopened.profile)).text, /page/);

  // The check list runs finds a stuck Chrome nobody has used, and close kills it without asking first.
  const secondPid = chromePid(profile);
  assert.notEqual(secondPid, firstPid);
  stopped.push(secondPid);
  process.kill(secondPid, "SIGSTOP");
  await manager.checkResponding();
  assert.equal(responding(reopened.profile), false);
  started = Date.now();
  await manager.close(reopened.profile);
  assert.ok(Date.now() - started < 3_000, `close took ${Date.now() - started} ms`);
  assert.equal(isRunning(secondPid), false, "close left the stuck Chrome running");
  assert.deepEqual(manager.active(), []);
});
