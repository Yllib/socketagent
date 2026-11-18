const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const test = require("node:test");
require("./test-data-dir");
const { saveSession, getSession } = require("#server/session-store");
const { ClaudeSession } = require("#server/claude-session");
const { parseServerMessage } = require("#server/server-message");

// A chat reopened after a server restart has no live session ID until its
// first turn starts, only the ID it will resume. A model picked in that window
// has to land on the open session, be saved, and show its card.
test("a model picked in a reopened chat before its first turn is saved and shown", async () => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  saveSession({ id, title: "Reopened", cwd: os.tmpdir(), createdAt: now, lastActive: now, messagePreview: "",
    agentSettings: { model: "claude-fable-5-2" } });
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new ClaudeSession({
    readyState: 1,
    supportsSessionEventAck: false,
    send(payload) { sent.push(parseServerMessage(JSON.parse(payload))); },
  }, os.tmpdir(), []);
  session._resumeSessionId = id;
  // What resume_session does with the saved settings.
  await session.setModel("claude-fable-5-2");
  assert.equal(session.getSessionId(), null);

  await session.setModel("opus");

  assert.equal(session.sessionModel, "opus");
  assert.equal(getSession(id)?.agentSettings?.model, "opus");
  const card = sent.find((message) => message.type === "model_changed");
  assert.ok(card && card.type === "model_changed");
  assert.equal(card.sessionId, id);
  assert.match(card.content, /to Opus|to opus/);
});
