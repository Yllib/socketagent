const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = path.join(os.tmpdir(), `socketagent-gemini-tools-${crypto.randomUUID()}`);
process.env.SOCKET_AGENT_DATA_DIR = tempDir;
fs.mkdirSync(tempDir, { recursive: true });

const { AcpClient } = require("#server/gemini-acp-client");
const { GeminiSession, normalizeGeminiToolCall } = require("#server/gemini-session");
const { getHistory, getSession, saveSession } = require("#server/session-store");
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

test("normalizeGeminiToolCall maps agy built-in and SocketAgent MCP tools to canonical card shapes", () => {
  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "run_command",
      kind: "execute",
      title: "git status",
      rawInput: { CommandLine: "git status", toolSummary: "Check git status" },
    }),
    { tool: "Bash", input: { command: "git status", description: "Check git status" } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "edit_file",
      kind: "edit",
      rawInput: { Path: "/repo/a.ts", Target: "old\n", Replacement: "new\n" },
    }),
    { tool: "Edit", input: { file_path: "/repo/a.ts", old_string: "old\n", new_string: "new\n" } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "edit_file",
      kind: "edit",
      rawInput: { Path: "/repo/b.ts" },
      content: [{ type: "diff", path: "/repo/b.ts", oldText: "before", newText: "after" }],
    }),
    { tool: "Edit", input: { file_path: "/repo/b.ts", old_string: "before", new_string: "after" } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "write_file",
      rawInput: { Path: "/repo/new.ts", Content: "export const x = 1;\n" },
    }),
    { tool: "Write", input: { file_path: "/repo/new.ts", content: "export const x = 1;\n" } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "read_file",
      rawInput: { Path: "/repo/a.ts", StartLine: 10, EndLine: 29 },
    }),
    { tool: "Read", input: { file_path: "/repo/a.ts", offset: 10, limit: 20 } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "search_web",
      rawInput: { query: "socketagent acp", domain: "example.com" },
    }),
    { tool: "WebSearch", input: { query: "socketagent acp", domain: "example.com" } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "invoke_subagent",
      rawInput: { Role: "Code Reviewer", Prompt: "Audit diff", TypeName: "research" },
    }),
    { tool: "Agent", input: { description: "Code Reviewer", prompt: "Audit diff", subagent_type: "research" } },
  );

  assert.deepEqual(
    normalizeGeminiToolCall({
      name: "mcp_socketagent_app_SendFile",
      rawInput: { file_path: "/tmp/app.apk", toolSummary: "Send APK" },
    }),
    { tool: "SendFile", input: { file_path: "/tmp/app.apk", toolSummary: "Send APK" } },
  );
});

test("Gemini streams incremental tool_result_chunk updates and publishes context_usage", () => {
  const sessionId = crypto.randomUUID();
  saveSession({
    id: sessionId,
    title: "Gemini cards test",
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
        sessionUpdate: "tool_call",
        toolCallId: "cmd-1",
        name: "run_command",
        kind: "execute",
        rawInput: { CommandLine: "echo hi", toolSummary: "Say hi" },
        status: "in_progress",
      },
    },
  });
  session.handleNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        status: "in_progress",
        rawOutput: { output: "line 1\n" },
      },
    },
  });
  session.handleNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        status: "in_progress",
        rawOutput: { output: "line 1\nline 2\n" },
      },
    },
  });
  session.handleNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        status: "completed",
        rawOutput: { output: "line 1\nline 2\n" },
      },
    },
  });
  session.handleNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 12000,
        size: 1000000,
      },
    },
  });

  const toolCall = sent.find((m) => m.type === "tool_call");
  assert.equal(toolCall?.tool, "Bash");
  assert.deepEqual(toolCall?.input, { command: "echo hi", description: "Say hi" });

  const chunks = sent.filter((m) => m.type === "tool_result_chunk");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[0].content, "line 1\n");
  assert.equal(chunks[1].chunkIndex, 1);
  assert.equal(chunks[1].content, "line 2\n");

  const contextUsage = sent.find((m) => m.type === "context_usage");
  assert.equal(contextUsage?.totalTokens, 12000);
  assert.equal(contextUsage?.maxTokens, 1000000);
  assert.equal(getSession(sessionId)?.lastContextUsage?.totalTokens, 12000);

  const history = getHistory(sessionId);
  assert.equal(history[0]?.toolName, "Bash");
});

test("Gemini runQuery records optional 3rd clientMessageId and emits running/idle state transitions", async () => {
  const FAKE_AGENT = `
    const rl = require("readline").createInterface({ input: process.stdin });
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    rl.on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
      else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "gemini-cid-1", configOptions: [] } });
      else if (m.method === "session/prompt") send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 10 } } });
    });
  `;
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  const client = new AcpClient({ command: process.execPath, args: ["-e", FAKE_AGENT], cwd: process.cwd() });
  client.on(
    "notification",
    /** @param {import("#server/gemini-acp-client").AcpNotification} note */
    (note) => session.handleNotification(note),
  );
  await client.initialize();
  session.client = client;

  try {
    await session.runQuery("hello", undefined, "client-msg-42");
    const promptAnnouncement = sent.find((m) => m.type === "user_message_uuid");
    assert.equal(promptAnnouncement?.uuid, "client-msg-42");
    assert.equal(promptAnnouncement?.clientMessageId, "client-msg-42");

    const states = sent.filter((m) => m.type === "session_state_changed").map((m) => m.state);
    assert.deepEqual(states, ["running", "idle"]);

    const usageUpdate = sent.find((m) => m.type === "usage_update");
    assert.equal(usageUpdate?.inputTokens, 20);
    assert.equal(usageUpdate?.outputTokens, 10);
  } finally {
    await session.dispose();
  }
});

test("Gemini anchors cumulative multi-step result.usage to authoritative usage_update context fill", async () => {
  const FAKE_AGENT = `
    const rl = require("readline").createInterface({ input: process.stdin });
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    rl.on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
      else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "gemini-ctx-1", configOptions: [] } });
      else if (m.method === "session/prompt") {
        send({
          method: "session/update",
          params: {
            sessionId: "gemini-ctx-1",
            update: { sessionUpdate: "usage_update", used: 478105, size: 1048576 },
          },
        });
        send({
          id: m.id,
          result: {
            stopReason: "end_turn",
            usage: {
              inputTokens: 5585,
              outputTokens: 356,
              cachedReadTokens: 942426,
              cachedWriteTokens: 0,
            },
          },
        });
      }
    });
  `;
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  const client = new AcpClient({ command: process.execPath, args: ["-e", FAKE_AGENT], cwd: process.cwd() });
  client.on(
    "notification",
    /** @param {import("#server/gemini-acp-client").AcpNotification} note */
    (note) => session.handleNotification(note),
  );
  await client.initialize();
  session.client = client;

  try {
    await session.runQuery("check context meter");
    const contextUsage = sent.find((m) => m.type === "context_usage");
    assert.equal(contextUsage?.totalTokens, 478105);
    assert.equal(contextUsage?.maxTokens, 1048576);

    const usageUpdates = sent.filter((m) => m.type === "usage_update");
    assert.ok(usageUpdates.length >= 2);
    const finalUsage = usageUpdates[usageUpdates.length - 1];
    assert.equal(
      (finalUsage.inputTokens ?? 0) + (finalUsage.cacheReadTokens ?? 0) + (finalUsage.cacheCreateTokens ?? 0),
      478105,
    );
    assert.equal(finalUsage.outputTokens, 356);
    assert.equal(finalUsage.contextWindow, 1048576);
  } finally {
    await session.dispose();
  }
});
