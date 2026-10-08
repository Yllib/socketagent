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

// Repaints every animation frame, so the screencast always has a new frame to send.
const PAGE = `<body><h1 id="n">0</h1><script>
  let n = 0;
  const tick = () => { document.getElementById("n").textContent = String(++n); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
</script></body>`;

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));

test("a viewer that stops acknowledging frames gets no more than two ahead", {
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
  const profile = `test-stream-${crypto.randomBytes(4).toString("hex")}`;
  /** @type {number[]} */
  const seqs = [];
  const unsubscribe = manager.onFrame((frame) => {
    if (frame.profile === profile && frame.seq !== undefined) seqs.push(frame.seq);
  });
  t.after(async () => {
    unsubscribe();
    await manager.clear(profile).catch(() => {});
    server.close();
  });
  await manager.open(profile, `http://127.0.0.1:${address.port}/`);
  await manager.watch(profile);

  const waitForFrames = async (/** @type {number} */ count) => {
    for (let attempt = 0; attempt < 100 && seqs.length < count; attempt++) await sleep(50);
    assert.ok(seqs.length >= count, `expected ${count} frames, got ${seqs.length}`);
  };

  // Before any ack the stream is paced by time alone, as older apps expect.
  await waitForFrames(3);
  manager.ackFrame(profile, seqs[seqs.length - 1]);
  const shown = seqs.length;

  // Well under the ack timeout, at the 200 ms floor this would be four frames.
  await sleep(900);
  assert.equal(seqs.length - shown, 2);

  manager.ackFrame(profile, seqs[seqs.length - 1]);
  await waitForFrames(shown + 3);
});
