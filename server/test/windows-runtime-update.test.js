const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");

test("starts listening only after relay-visible runtime state is initialized", () => {
  const listenAt = source.lastIndexOf("httpServer.listen(PORT, BIND_HOST");
  assert.ok(listenAt > source.indexOf("const SERVER_STARTED_AT"));
  assert.ok(listenAt > source.indexOf("const GIT_ROOT"));
  assert.ok(listenAt > source.indexOf("let managedBackendUpdatePromise"));
});

test("Windows batch updates preserve executable paths containing spaces", () => {
  assert.match(
    source,
    /const commandLine = \["call", quoteWindowsCmdArg\(command\), \.\.\.args\.map\(quoteWindowsCmdArg\)\]/,
  );
  assert.doesNotMatch(source, /`"\$\{commandLine\}"`/);
  assert.match(source, /windowsVerbatimArguments: true/);
  assert.match(source, /windowsVerbatimArguments: spec\.windowsVerbatimArguments/);
  assert.match(source, /windowsVerbatimArguments: npm\.windowsVerbatimArguments/);
  assert.match(source, /windowsVerbatimArguments: npx\.windowsVerbatimArguments/);
  assert.match(source, /windowsVerbatimArguments: view\.windowsVerbatimArguments/);
});
