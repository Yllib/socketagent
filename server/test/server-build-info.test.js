const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const packageJson = require("../package.json");
const { SERVER_RELEASE_VERSION } = require("../dist/server-build-info");

test("server release version comes from the server package", () => {
  assert.equal(SERVER_RELEASE_VERSION, packageJson.version);
  assert.match(SERVER_RELEASE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("server release version is included in connection and heartbeat metadata", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "..", "src", "index.ts"),
    "utf8",
  );
  assert.match(source, /serverReleaseVersion:\s*SERVER_RELEASE_VERSION/);
  assert.match(source, /serverCommit:\s*SERVER_GIT_HASH/);
});
