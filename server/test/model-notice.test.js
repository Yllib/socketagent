const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SOCKET_AGENT_DATA_DIR = path.join(os.tmpdir(), `socketagent-model-notice-${crypto.randomUUID()}`);
fs.mkdirSync(process.env.SOCKET_AGENT_DATA_DIR, { recursive: true });

const { claudeModelVersion, outdatedModelWarning } = require("../dist/model-change.js");

// Shape of the Claude catalog the CLI reports: aliases carry the newest version in displayName.
const catalog = [
  { value: "default", displayName: "Default (recommended)" },
  { value: "opus", displayName: "Opus 5.5" },
  { value: "haiku", displayName: "Haiku 5.5" },
  { value: "claude-opus-4-8", displayName: "Opus 4.8" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];

test("parses model ids and display names", () => {
  assert.deepEqual(claudeModelVersion("claude-opus-4-8"), { family: "opus", major: 4, minor: 8 });
  assert.deepEqual(claudeModelVersion("claude-haiku-4-5-20251001"), { family: "haiku", major: 4, minor: 5 });
  assert.deepEqual(claudeModelVersion("claude-opus-5"), { family: "opus", major: 5, minor: 0 });
  assert.deepEqual(claudeModelVersion("Opus 5.5"), { family: "opus", major: 5, minor: 5 });
  assert.equal(claudeModelVersion("opus"), null);
});

test("warns about each model older than the newest of its family", () => {
  assert.equal(
    outdatedModelWarning(["claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-opus-4-8"], catalog),
    "Old model. Opus 4.8 answered this turn, not Opus 5.5. Haiku 4.5 answered this turn, not Haiku 5.5.",
  );
});

test("stays quiet for current models and unknown families", () => {
  assert.equal(outdatedModelWarning(["claude-opus-5-5", "claude-fable-5-1"], catalog), null);
  assert.equal(outdatedModelWarning(["claude-opus-4-8"], []), null);
});
