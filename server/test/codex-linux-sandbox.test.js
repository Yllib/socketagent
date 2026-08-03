const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyBubblewrapProbe,
  getCodexLinuxSandboxHealth,
} = require("../dist/codex-linux-sandbox");

test("Codex Bubblewrap health is Linux-only", () => {
  assert.equal(
    classifyBubblewrapProbe("win32", { status: 1, error: { code: "ENOENT" }, stdout: "", stderr: "" }),
    null,
  );
  assert.equal(getCodexLinuxSandboxHealth("darwin"), null);
});

test("missing Bubblewrap produces an actionable warning", () => {
  const health = classifyBubblewrapProbe("linux", {
    status: null,
    error: Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT" }),
    stdout: "",
    stderr: "",
  });
  assert.equal(health.available, false);
  assert.match(health.reason, /Bubblewrap \(bwrap\) is missing/);
  assert.match(health.reason, /automatic repair/);
});

test("blocked Bubblewrap preserves a concise diagnostic", () => {
  const health = classifyBubblewrapProbe("linux", {
    status: 1,
    stdout: "",
    stderr: "bwrap: No permissions to create new namespace\nsecondary detail",
  });
  assert.equal(health.available, false);
  assert.match(health.reason, /cannot create the Linux sandbox/);
  assert.equal(health.detail, "bwrap: No permissions to create new namespace");
});

test("successful Bubblewrap probe is healthy", () => {
  assert.deepEqual(
    classifyBubblewrapProbe("linux", { status: 0, stdout: "", stderr: "" }),
    { available: true },
  );
});
