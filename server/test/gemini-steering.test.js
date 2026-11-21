const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = path.join(os.tmpdir(), `socketagent-gemini-steer-${crypto.randomUUID()}`);
process.env.SOCKET_AGENT_DATA_DIR = tempDir;
fs.mkdirSync(tempDir, { recursive: true });

const { AcpClient } = require("#server/gemini-acp-client");
const { GeminiSession } = require("#server/gemini-session");
const { getHistory } = require("#server/session-store");
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

// Stand-in for `agy acp`: mirrors agy's Lease.Steer behavior when a second
// session/prompt arrives while a first turn is still running.
const FAKE_STEER_AGENT = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let activePromptId = null;
let sessionId = "gemini-steer-session-1";
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake-agy" } } });
  } else if (m.method === "session/new") {
    send({ id: m.id, result: { sessionId, configOptions: [] } });
  } else if (m.method === "session/prompt") {
    const text = (m.params.prompt || []).map((b) => b.text || "").join("");
    if (activePromptId !== null) {
      const superseded = activePromptId;
      activePromptId = m.id;
      // agy immediately resolves the superseded prompt and hands turn ownership to the steer.
      send({ id: superseded, result: { stopReason: "end_turn" } });
      setTimeout(() => {
        send({
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { output: "ok" } } },
        });
        send({
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STEERED:" + text } } },
        });
        const finishId = activePromptId;
        activePromptId = null;
        send({ id: finishId, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } });
      }, 60);
    } else {
      activePromptId = m.id;
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", name: "Bash", rawInput: { command: "sleep 1" }, status: "in_progress" } },
      });
    }
  }
});
`;

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("Gemini steers a running turn via concurrent session/prompt without ending the turn early", async () => {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  const client = new AcpClient({ command: process.execPath, args: ["-e", FAKE_STEER_AGENT], cwd: process.cwd() });
  client.on("notification", (/** @type {import("#server/gemini-acp-client").AcpNotification} */ note) => {
    session.handleNotification(note);
  });
  await client.initialize();
  session.client = client;

  try {
    const runPromise = session.runQueryWithOptions("initial task", undefined, { messageId: "msg-1" });

    // Wait for the first turn's tool call to arrive.
    const deadline = Date.now() + 5_000;
    while (!sent.some((m) => m.type === "tool_call") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(session.isRunning, true);

    // Queue a "later" message and retract it to confirm later-queue behavior still works.
    const laterPromise = session.injectMessage("do later", "later", "msg-later");
    assert.equal(session.retractQueuedPrompt("msg-later"), "do later");
    await assert.rejects(laterPromise, /Queued prompt retracted/);

    // Steer with default "next" priority: should acknowledge immediately while turn keeps running.
    await session.injectMessage("switch to banana", "next", "msg-2");
    assert.equal(session.isRunning, true);
    assert.equal(sent.some((m) => m.type === "result"), false);

    await runPromise;
    assert.equal(session.isRunning, false);

    const results = sent.filter((m) => m.type === "result");
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "STEERED:switch to banana");
    assert.equal(results[0].usage?.inputTokens, 10);

    const history = getHistory("gemini-steer-session-1");
    const userPrompts = history.filter((entry) => entry.role === "user").map((entry) => entry.content);
    assert.deepEqual(userPrompts, ["initial task", "switch to banana"]);
    const toolResult = history.find((entry) => entry.role === "tool_result");
    assert.equal(toolResult?.toolOutput, "ok");
  } finally {
    await session.dispose();
  }
});
