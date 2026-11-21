const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = path.join(os.tmpdir(), `socketagent-gemini-life-${crypto.randomUUID()}`);
process.env.SOCKET_AGENT_DATA_DIR = path.join(tempDir, "data");
process.env.SOCKET_AGENT_HOME = path.join(tempDir, "home");
fs.mkdirSync(process.env.SOCKET_AGENT_DATA_DIR, { recursive: true });

const { GeminiSession } = require("#server/gemini-session");
const { parseServerMessage } = require("#server/server-message");

const agyDir = path.join(process.env.SOCKET_AGENT_HOME, "toolchains", "agy");
const promptLog = path.join(tempDir, "prompts.log");

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

/**
 * Installs a stand-in `agy` that GeminiSession finds as SocketAgent's managed
 * copy. [onPrompt] is the body of a function `(m, send, sessionId)` run for each
 * session/prompt after it is logged to prompts.log.
 * @param {{ initDelayMs?: number, onPrompt: string, onCancel?: string }} behavior
 */
function installFakeAgy(behavior) {
  fs.mkdirSync(agyDir, { recursive: true });
  fs.rmSync(promptLog, { force: true });
  const file = path.join(agyDir, process.platform === "win32" ? "agy.exe" : "agy");
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require("fs");
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const sessionId = "gemini-life-1";
let promptId = null;
const onPrompt = (m) => { ${behavior.onPrompt} };
const onCancel = () => { ${behavior.onCancel ?? ""} };
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") setTimeout(() => send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake-agy" } } }), ${behavior.initDelayMs ?? 0});
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId, configOptions: [] } });
  else if (m.method === "session/prompt") { promptId = m.id; fs.appendFileSync(${JSON.stringify(promptLog)}, "prompt\\n"); onPrompt(m); }
  else if (m.method === "session/cancel") onCancel();
});
`, { mode: 0o755 });
}

/** @param {() => boolean} check */
async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const BACKGROUND_COMMAND = `
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "bg-1", name: "run_command", kind: "execute", rawInput: { CommandLine: "npm run dev" }, status: "in_progress" } } });
  setTimeout(() => send({ id: m.id, result: { stopReason: "end_turn" } }), 30);
`;

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("Stop while agy is starting ends the turn before any prompt reaches agy", async () => {
  installFakeAgy({ initDelayMs: 400, onPrompt: `send({ id: m.id, result: { stopReason: "end_turn" } });` });
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), tempDir, []);
  try {
    const run = session.runQuery("hello", undefined, "msg-1").then(() => "finished", () => "failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.abort();
    assert.equal(await run, "failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fs.existsSync(promptLog), false);
    assert.equal(session.isRunning, false);
    assert.equal(sent.some((m) => m.type === "error"), false);
  } finally {
    await session.dispose();
  }
});

test("Stop's fallback timer does not stop the next turn", async () => {
  installFakeAgy({
    onPrompt: `if (fs.readFileSync(${JSON.stringify(promptLog)}, "utf8").split("\\n").length > 2) setTimeout(() => send({ id: m.id, result: { stopReason: "end_turn" } }), 300);`,
    onCancel: `send({ id: promptId, result: { stopReason: "cancelled" } });`,
  });
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), tempDir, []);
  session.abortKillMs = 100;
  try {
    const first = session.runQuery("first", undefined, "msg-1");
    await waitFor(() => fs.existsSync(promptLog));
    await session.abort();
    await first;
    await session.runQuery("second", undefined, "msg-2");
    const results = sent.filter((m) => m.type === "result");
    assert.equal(results.at(-1)?.type === "result" && results.at(-1)?.stopReason, "end_turn");
  } finally {
    await session.dispose();
  }
});

test("Stop with a background command stops agy and clears the task", async () => {
  installFakeAgy({ onPrompt: BACKGROUND_COMMAND });
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), tempDir, []);
  try {
    await session.runQuery("start the dev server", undefined, "msg-1");
    assert.deepEqual([...session.activeBackgroundTasks.keys()], ["bg-1"]);
    await session.abort();
    assert.equal(session.activeBackgroundTasks.size, 0);
    assert.equal(session.isWarmIdle, false);
    assert.ok(sent.some((m) => m.type === "task_notification" && m.taskId === "bg-1" && m.status === "stopped"));
  } finally {
    await session.dispose();
  }
});

test("agy exiting settles background tasks, open approvals and out-of-turn output", async () => {
  installFakeAgy({
    onPrompt: `${BACKGROUND_COMMAND}
      setTimeout(() => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still going" } } } }), 80);
      setTimeout(() => send({ id: "perm-1", method: "session/request_permission", params: { sessionId, toolCall: { kind: "execute", rawInput: { CommandLine: "rm -rf build" } }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } }), 100);
      setTimeout(() => process.exit(1), 250);`,
  });
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), tempDir, []);
  try {
    await session.runQuery("start the dev server", undefined, "msg-1");
    await waitFor(() => sent.some((m) => m.type === "question"));
    assert.equal(session.isRunning, true);
    await waitFor(() => !session.isBusy);
    assert.equal(session.isRunning, false);
    assert.equal(session.activeBackgroundTasks.size, 0);
    assert.ok(sent.some((m) => m.type === "task_notification" && m.taskId === "bg-1" && m.status === "failed"));
    assert.ok(sent.some((m) => m.type === "question_answered"));
  } finally {
    await session.dispose();
  }
});

test("A file change that names no file is denied without asking", async () => {
  /** @type {string[]} */
  const checked = [];
  /** @type {import("#server/plugin-api").SocketAgentPlugin} */
  const plugin = {
    name: "protect",
    async canUseToolInterceptor(_tool, input) {
      checked.push(String(input.file_path));
      return input.file_path === "/etc/hosts" ? { behavior: "deny", message: "protected" } : undefined;
    },
  };
  const session = new GeminiSession(testSocket([]), tempDir, [plugin]);
  session._permissionMode = "bypassPermissions";
  assert.equal(await session.approve({ kind: "edit", rawInput: {} }), false);
  assert.equal(await session.approve({ kind: "edit", name: "write_to_file", rawInput: { TargetFile: "/etc/hosts" } }), false);
  assert.deepEqual(checked, ["/etc/hosts"]);
  await session.dispose();
});
