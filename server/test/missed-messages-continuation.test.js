const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-missed-messages-"));
process.env.HOME = scratch;
process.env.SOCKET_AGENT_DATA_DIR = path.join(scratch, "data");

const {
  getMissedMessages,
  getJsonlPath,
  getUnrecordedClaudeMessages,
  hasClaudeTranscript,
  recordUserPrompt,
} = require("#server/session-store");
const { RESTART_CONTINUATION_PROMPT } = require("#server/restart-recovery");

// SocketAgent hands the continuation prompt to the model, so the SDK records
// it in its transcript. Reading that transcript back turned it into a user
// message in the chat, which is how it reached the user twice.

const SESSION_ID = "test-continuation-00000000-0000-4000-8000-000000000001";
const CWD = path.join(os.tmpdir(), "socketagent-missed-messages-test");

/** @param {unknown[]} lines */
function writeTranscript(lines) {
  const p = getJsonlPath(SESSION_ID, CWD);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

/** @param {string | {type: string, text: string}[]} content @param {string} timestamp @param {string} [uuid] */
function userMessage(content, timestamp, uuid) {
  return { type: "user", timestamp, ...(uuid ? { uuid } : {}), message: { role: "user", content } };
}

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

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

// SocketAgent records a prompt a few milliseconds before Claude writes it to
// its transcript. Opening the chat in that window read the prompt back as
// missed, so it showed twice.
test("a prompt already in history is not read back from the transcript", (t) => {
  const uuid = "18b093b4-7dca-8d74-b03d-accdb8176e3d";
  recordUserPrompt({
    sessionId: SESSION_ID,
    content: "go ahead with phase two",
    uuid,
    timestamp: "2026-10-13T01:57:56.960Z",
  });
  const written = writeTranscript([
    userMessage("go ahead with phase two", "2026-10-13T01:57:56.985Z", uuid),
    userMessage("typed in the terminal", "2026-10-13T01:58:10.000Z", "0b1c2d3e-0000-4000-8000-000000000002"),
  ]);
  t.after(() => fs.rmSync(path.dirname(written), { recursive: true, force: true }));

  const added = getUnrecordedClaudeMessages(SESSION_ID, CWD, "2026-10-13T01:57:56.960Z");

  assert.deepEqual(added.map((e) => e.content), ["typed in the terminal"]);
});

test("a transcript Claude Code deleted is reported missing", () => {
  const p = writeTranscript([userMessage("hi", "2026-01-01T00:00:00.000Z")]);
  assert.equal(hasClaudeTranscript(SESSION_ID), true);
  fs.rmSync(p);
  assert.equal(hasClaudeTranscript(SESSION_ID), false);
});
