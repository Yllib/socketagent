const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { serverReleaseVersionFor, SERVER_RELEASE_VERSION } = require("../dist/server-build-info");

// The patch number is read off a list of many connected machines to see which
// have updated, so it has to advance on its own. A hand-bumped one is stale
// exactly when it matters.

test("the patch number is the commit count on the ref", () => {
  const count = execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: __dirname,
    encoding: "utf8",
  }).trim();
  assert.equal(serverReleaseVersionFor("HEAD", "1.1.34"), `1.1.${count}`);
});

test("major and minor stay hand-set", () => {
  assert.match(serverReleaseVersionFor("HEAD", "2.7.0"), /^2\.7\.\d+$/);
});

test("two refs at the same commit report the same version", () => {
  // The whole point: machines that are up to date must agree exactly.
  assert.equal(serverReleaseVersionFor("HEAD", "1.1.34"), serverReleaseVersionFor("HEAD~0", "1.1.34"));
  assert.notEqual(serverReleaseVersionFor("HEAD", "1.1.34"), serverReleaseVersionFor("HEAD~1", "1.1.34"));
});

test("without git it falls back to the committed version", () => {
  assert.equal(serverReleaseVersionFor("no-such-ref", "1.1.34"), "1.1.34");
  assert.equal(serverReleaseVersionFor("no-such-ref", undefined), "0.0.0");
  assert.equal(serverReleaseVersionFor("no-such-ref", "  "), "0.0.0");
});

test("the exported constant is derived too", () => {
  assert.equal(SERVER_RELEASE_VERSION, serverReleaseVersionFor("HEAD", require("../package.json").version));
});
