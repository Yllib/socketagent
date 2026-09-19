const assert = require("node:assert/strict");
const test = require("node:test");
require("./test-data-dir");

const { ClaudeSession } = require("../dist/claude-session");
const { recordUserPrompt, getHistory } = require("../dist/session-store");

function testSocket(sent) {
  return {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

test("a recorded prompt is announced with the text clients need to render it", () => {
  const announcement = recordUserPrompt({
    sessionId: "announced-prompt",
    content: "check the build",
    uuid: "uuid-1",
    clientMessageId: "client-1",
  });

  assert.equal(announcement.type, "user_message_uuid");
  assert.equal(announcement.content, "check the build");
  assert.equal(announcement.clientMessageId, "client-1");
  assert.ok(announcement.entryId);

  const [entry] = getHistory("announced-prompt");
  assert.equal(entry.role, "user");
  assert.equal(entry.content, "check the build");
  assert.equal(entry.uuid, "uuid-1");
});

// A phone and a desktop can watch one session at once. Every attached client
// has to see the prompt, not only the one that sent it.
test("a prompt reaches every client attached to the session", async () => {
  const phone = [];
  const desktop = [];
  const session = new ClaudeSession(testSocket(phone), process.cwd(), []);
  session.sessionId = "shared-session";
  session.activeQuery = {};
  session._isRunning = true;
  session.setWebSocket(testSocket(desktop));

  await session.injectMessage("check the build", "next", "client-1");

  for (const sent of [phone, desktop]) {
    const announced = sent.filter((msg) => msg.type === "user_message_uuid");
    assert.equal(announced.length, 1);
    assert.equal(announced[0].content, "check the build");
    assert.equal(announced[0].sessionId, "shared-session");
    assert.equal(announced[0].clientMessageId, "client-1");
  }
});
