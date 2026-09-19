const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { getMissedMessages, getJsonlPath } = require("../dist/session-store");
const { RESTART_CONTINUATION_PROMPT } = require("../dist/restart-recovery");

// SocketAgent hands the continuation prompt to the model, so the SDK records
// it in its transcript. Reading that transcript back turned it into a user
// message in the chat, which is how it reached the user twice.

const SESSION_ID = "test-continuation-00000000-0000-4000-8000-000000000001";
const CWD = path.join(os.tmpdir(), "socketagent-missed-messages-test");

function writeTranscript(lines) {
  const p = getJsonlPath(SESSION_ID, CWD);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

function userMessage(content, timestamp) {
  return { type: "user", timestamp, message: { role: "user", content } };
}

test("the continuation prompt is not replayed as a user message", (t) => {
  const written = writeTranscript([
    userMessage("what broke the session list?", "2026-09-19T01:00:00.000Z"),
    userMessage(RESTART_CONTINUATION_PROMPT, "2026-09-19T01:00:01.000Z"),
    userMessage(
      [{ type: "text", text: RESTART_CONTINUATION_PROMPT }],
      "2026-09-19T01:00:02.000Z",
    ),
    userMessage([{ type: "text", text: "and now?" }], "2026-09-19T01:00:03.000Z"),
  ]);
  t.after(() => fs.rmSync(path.dirname(written), { recursive: true, force: true }));

  const missed = getMissedMessages(SESSION_ID, CWD, "2026-09-19T00:00:00.000Z");
  const userText = missed.filter((e) => e.role === "user").map((e) => e.content);

  assert.deepEqual(userText, ["what broke the session list?", "and now?"]);
  assert.equal(
    missed.some((e) => String(e.content).includes("SocketAgent restarted while")),
    false,
    "the prompt must not come back through the transcript either",
  );
});
