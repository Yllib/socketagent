const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = path.join(os.tmpdir(), `socketagent-gemini-bg-${crypto.randomUUID()}`);
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

// Mirrors agy acp when a run_command exceeds WaitMsBeforeAsync:
// 1. tool_call stays in_progress while the model says "waiting" and session/prompt ends.
// 2. Later, tool_call_update status="completed" delivers the real output.
// 3. agy streams an out-of-turn reactive wakeup reply followed by usage_update.
const FAKE_BG_AGENT = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const sid = "gemini-bg-session-1";
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: 1 } });
  } else if (m.method === "session/new") {
    send({ id: m.id, result: { sessionId: sid, configOptions: [] } });
  } else if (m.method === "session/prompt") {
    send({
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "bg-cmd-1",
          name: "run_command",
          kind: "execute",
          rawInput: { CommandLine: "npm run type-safety", toolSummary: "Run type safety" },
          status: "in_progress",
        },
      },
    });
    setTimeout(() => {
      send({
        method: "session/update",
        params: {
          sessionId: sid,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting on type-safety." } },
        },
      });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }, 30);
    setTimeout(() => {
      send({
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bg-cmd-1",
            status: "completed",
            rawOutput: { output: "Type safety: 0 diagnostics" },
          },
        },
      });
      send({
        method: "session/update",
        params: {
          sessionId: sid,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Type-safety finished cleanly." } },
        },
      });
      send({
        method: "session/update",
        params: {
          sessionId: sid,
          update: { sessionUpdate: "usage_update", used: 9500, size: 1000000 },
        },
      });
    }, 120);
  }
});
`;

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("Gemini promotes backgrounded run_command to BG/Waiting, delivers completion, and persists reactive wakeup", async () => {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  session.outOfTurnSettleMs = 40;
  /** @type {boolean[]} */
  const harnessStates = [];
  session.onHarnessRunStateChanged = (running) => harnessStates.push(running);

  const client = new AcpClient({ command: process.execPath, args: ["-e", FAKE_BG_AGENT], cwd: process.cwd() });
  client.on("notification", (/** @type {import("#server/gemini-acp-client").AcpNotification} */ note) => {
    session.handleNotification(note);
  });
  await client.initialize();
  session.client = client;

  try {
    await session.runQuery("run type safety");

    // Turn ended, but the background command is still running: not working, still busy, listed in activeBackgroundTasks.
    assert.equal(session.isRunning, false);
    assert.equal(session.isBusy, true);
    assert.equal(session.activeBackgroundTasks.get("bg-cmd-1"), "Run type safety");
    const bgSnapshot = sent.find((m) => m.type === "background_tasks_changed");
    assert.ok(bgSnapshot && bgSnapshot.type === "background_tasks_changed");
    assert.deepEqual(bgSnapshot.tasks, [{
      taskId: "bg-cmd-1",
      taskType: "local_bash",
      description: "Run type safety",
      toolUseId: "bg-cmd-1",
    }]);

    // Wait for background task completion + out-of-turn wakeup to settle.
    const deadline = Date.now() + 5_000;
    while ((session.isBusy || harnessStates.length < 2) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(session.isRunning, false);
    assert.equal(session.isBusy, false);
    assert.equal(session.activeBackgroundTasks.size, 0);
    assert.deepEqual(harnessStates, [true, false]);

    const toolResults = sent.filter((m) => m.type === "tool_result" && m.toolUseId === "bg-cmd-1");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].output, "Type safety: 0 diagnostics");

    const taskNotif = sent.find((m) => m.type === "task_notification" && m.taskId === "bg-cmd-1");
    assert.ok(taskNotif && taskNotif.type === "task_notification");
    assert.equal(taskNotif.status, "completed");
    assert.equal(taskNotif.originToolUseId, "bg-cmd-1");

    const results = sent.filter((m) => m.type === "result");
    assert.equal(results.length, 2);
    assert.equal(results[1].content, "Type-safety finished cleanly.");

    const assistantTexts = getHistory("gemini-bg-session-1")
      .filter((entry) => entry.role === "assistant" && !entry.thinking)
      .map((entry) => entry.content);
    assert.deepEqual(assistantTexts, ["Waiting on type-safety.", "Type-safety finished cleanly."]);
  } finally {
    await session.dispose();
  }
});
