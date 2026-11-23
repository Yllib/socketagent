const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "..", "scripts", "check-deps.js");

/**
 * A server folder whose lockfile pins `required` 1.0.0 and an optional `native` 2.0.0.
 * @param {import("node:test").TestContext} t
 */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-deps-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "server" },
      "node_modules/required": { version: "1.0.0" },
      "node_modules/native": { version: "2.0.0", optional: true },
    },
  }));
  /**
   * @param {string} name
   * @param {string} version
   */
  const install = (name, version) => {
    fs.mkdirSync(path.join(dir, "node_modules", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  };
  const check = () => spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  return { install, check };
}

test("passes when every pinned package is installed, skipping optional ones npm left out", t => {
  const { install, check } = fixture(t);
  install("required", "1.0.0");
  assert.equal(check().status, 0);
});

test("fails when a package is missing or at another version", t => {
  const { install, check } = fixture(t);
  const missing = check();
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /required is missing/);

  install("required", "1.0.0");
  install("native", "1.9.0");
  const stale = check();
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /native is 1\.9\.0, the lockfile pins 2\.0\.0/);
});
