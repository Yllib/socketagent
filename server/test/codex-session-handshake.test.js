const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempDir = path.join(os.tmpdir(), `socketagent-codex-handshake-${crypto.randomUUID()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SOCKET_AGENT_DATA_DIR = tempDir;
// Stands in for the codex command: notes each launch, then runs the mock
// app-server, which refuses requests that arrive before the handshake.
const launches = path.join(tempDir, "launches");
const codex = path.join(tempDir, "codex");
fs.writeFileSync(codex, [
  "#!/bin/sh",
  `echo launched >> '${launches}'`,
  `exec '${process.execPath}' '${path.join(__dirname, "fixtures", "mock-codex-app-server.js")}'`,
  "",
].join("\n"), { mode: 0o755 });
process.env.CODEX_BIN = codex;

const { codexCaptureHookArgs } = require("#server/codex-capture-hook-config");
const { CodexSession } = require("#server/codex-session");

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const launchCount = () => fs.readFileSync(launches, "utf8").split("\n").filter(Boolean).length;

test("two requests arriving together share one Codex process that has had its handshake", {
  skip: process.platform === "win32" && "The stand-in codex command is a shell script",
}, async () => {
  // The capture hook check launches codex once per server run. Get it out of
  // the way so the count below is the session's own.
  await codexCaptureHookArgs();
  const before = launchCount();
  const session = new CodexSession({ readyState: 1, send() {} }, tempDir, []);
  try {
    // The app asks for several lists at once when a chat opens. Each caller
    // used to start its own process, and the session kept the one that never
    // got the handshake, so every later request failed with "Not initialized".
    await Promise.all([session.listCodexCollaborationModes(), session.listCodexCollaborationModes()]);
    assert.equal(launchCount() - before, 1);
  } finally {
    // listCodexCollaborationModes starts a model refresh it does not wait for.
    await session.refreshSupportedModels();
    await session.dispose();
  }
});
