const assert = require("node:assert/strict");
const test = require("node:test");
const { BackgroundProbe, runProbe } = require("#server/async-probe");

test("a probe settles at its timeout while a grandchild still holds its output", async () => {
  // The child starts a grandchild on the same stdio, like codex.cmd starting codex.exe.
  const script = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });"
    + "setTimeout(() => {}, 20000);";
  const startedAt = Date.now();
  const result = await runProbe(process.execPath, ["-e", script], { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  assert.ok(Date.now() - startedAt < 5000, `settled after ${Date.now() - startedAt} ms`);
});

test("background probes answer from the last result and re-probe after invalidation", async () => {
  let runs = 0;
  let changes = 0;
  /** @type {(value: string) => void} */
  let release = () => {};
  /** @returns {Promise<string>} */
  const nextResult = () => {
    runs++;
    return new Promise((resolve) => { release = resolve; });
  };
  const probe = new BackgroundProbe(nextResult, 60_000, () => { changes++; });

  assert.equal(probe.peek(), undefined, "the first read does not wait");
  assert.equal(runs, 1);
  const pending = probe.fresh();
  assert.equal(runs, 1, "readers share the running probe");
  release("ok");
  assert.equal(await pending, "ok");
  assert.equal(probe.peek(), "ok");
  assert.equal(changes, 1);

  probe.invalidate();
  assert.equal(probe.peek(), "ok", "an invalidated value stays readable until the new one arrives");
  assert.equal(runs, 2);
  release("ok");
  assert.equal(await probe.fresh(), "ok");
  assert.equal(changes, 1, "an unchanged result does not notify");
});
