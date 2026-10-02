const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isHeadlessClaudeTranscript } = require("#server/session-store");

/** @param {string} entrypoint */
function transcript(entrypoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-claude-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, [
    { type: "queue-operation", operation: "enqueue" },
    { type: "user", entrypoint, message: { role: "user", content: "hi" } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

test("only SDK-started Claude transcripts count as headless", () => {
  assert.equal(isHeadlessClaudeTranscript(transcript("sdk-ts")), true);
  assert.equal(isHeadlessClaudeTranscript(transcript("sdk-py")), true);
  assert.equal(isHeadlessClaudeTranscript(transcript("cli")), false);
  assert.equal(isHeadlessClaudeTranscript(path.join(os.tmpdir(), "missing-session.jsonl")), false);
});
