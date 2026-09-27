const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
require("./test-data-dir");
const { CodexSession } = require("#server/codex-session");
const { CodexAppServerClient } = require("#server/codex-app-server-client");
const { parseServerMessage } = require("#server/server-message");

function fixture() {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new CodexSession({
    readyState: 1, send: (value) => sent.push(parseServerMessage(JSON.parse(value))),
  }, process.cwd());
  session.sessionId = randomUUID();
  session._isRunning = true;
  const client = new CodexAppServerClient({ cwd: process.cwd() });
  session.appServer = client;
  return { session, client, sent };
}

test("Stop reports completion only after command cleanup succeeds", async (t) => {
  const { session, client, sent } = fixture();
  /** @type {() => void} */
  let release = () => { throw new Error("Cleanup gate not initialized"); };
  /** @type {Promise<void>} */
  const cleanup = new Promise((resolve) => { release = resolve; });
  t.mock.method(client, "stop", async () => cleanup);
  const stopping = session.abort();
  assert.equal(session.isRunning, true);
  assert.equal(sent.some((message) => message.type === "result"), false);
  release();
  await stopping;
  assert.equal(session.isRunning, false);
  assert.equal(sent.filter((message) => message.type === "result").length, 1);
});

test("hard Stop retries a concurrent idle cleanup failure instead of confirming it", async (t) => {
  const { session, client, sent } = fixture();
  /** @type {(error: Error) => void} */
  let failCleanup = () => { throw new Error("Cleanup gate not initialized"); };
  /** @type {Promise<void>} */
  const cleanup = new Promise((_, reject) => { failCleanup = reject; });
  let attempts = 0;
  t.mock.method(client, "stop", /** @param {NodeJS.Signals} signal @param {number} timeout @param {boolean} requireConfirmedExit */ async (signal, timeout, requireConfirmedExit) => {
    attempts++;
    if (attempts === 1) return cleanup;
    assert.equal(signal, "SIGKILL");
    assert.equal(requireConfirmedExit, true);
  });
  const idleCleanup = session.stopAppServerClient();
  const stopping = session.abort();
  failCleanup(new Error("Command did not exit"));
  await Promise.all([idleCleanup, stopping]);
  assert.equal(attempts, 2);
  assert.equal(session.appServer, null);
  assert.equal(sent.filter((message) => message.type === "result").length, 1);
});

test("failed Stop preserves the session for retry and emits no completed result", async (t) => {
  const { session, client, sent } = fixture();
  const stop = t.mock.method(client, "stop", async () => { throw new Error("Command did not exit"); });
  await assert.rejects(session.abort(), /Command did not exit/);
  assert.equal(session.isRunning, true);
  assert.equal(session.appServer, client);
  assert.equal(sent.some((message) => message.type === "result"), false);
  stop.mock.mockImplementation(async () => {});
  await session.abort();
  assert.equal(session.isRunning, false);
});
