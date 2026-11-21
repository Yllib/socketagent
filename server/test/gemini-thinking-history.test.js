const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = path.join(os.tmpdir(), `socketagent-gemini-thinking-${crypto.randomUUID()}`);
process.env.SOCKET_AGENT_DATA_DIR = tempDir;
fs.mkdirSync(tempDir, { recursive: true });

const { GeminiSession } = require("#server/gemini-session");
const { getHistory, saveSession } = require("#server/session-store");
const { parseServerMessage } = require("#server/server-message");

/** @param {import("#server/protocol").ServerMessage[]} sent @returns {import("#server/client-transport").ClientTransport} */
function testSocket(sent) {
  return {
    readyState: 1,
    supportsSessionEventAck: false,
    send(payload) {
      sent.push(parseServerMessage(JSON.parse(payload)));
    },
  };
}

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("Gemini persists finished thinking blocks at the same transcript position as live frames", () => {
  const sessionId = crypto.randomUUID();
  saveSession({
    id: sessionId,
    title: "Gemini thinking test",
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    messagePreview: "",
    backend: "gemini",
  });

  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  session.sessionId = sessionId;
  session.openSessionId = sessionId;

  session.handleNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking the model cache..." },
      },
    },
  });
  session.handleNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        name: "read_file",
        rawInput: { Path: "/tmp/a" },
        status: "in_progress",
      },
    },
  });

  const finalThinking = sent.find((msg) => msg.type === "thinking" && msg.finalSnapshot === true);
  assert.ok(finalThinking && finalThinking.type === "thinking");
  assert.equal(finalThinking.content, "Checking the model cache...");
  assert.ok(typeof finalThinking.thinkingDurationMs === "number" && finalThinking.thinkingDurationMs >= 1);

  const history = getHistory(sessionId);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "assistant");
  assert.equal(history[0].thinking, true);
  assert.equal(history[0].content, "Checking the model cache...");
  assert.equal(history[0].streamId, finalThinking.streamId);
  assert.equal(history[0].entryId, finalThinking.entryId);
  assert.equal(history[0].sessionSeq, finalThinking.sessionSeq);
  assert.equal(history[0].thinkingDurationMs, finalThinking.thinkingDurationMs);
  assert.equal(history[1].role, "tool_call");
  assert.ok(history[1].sessionSeq > history[0].sessionSeq);
});
