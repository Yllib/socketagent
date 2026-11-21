const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const { AcpClient, AcpError, ACP_AUTH_REQUIRED } = require("#server/gemini-acp-client");

// A stand-in for `agy acp`: answers initialize, refuses session/new as signed
// out, and on session/prompt asks permission first, then streams one chunk
// and answers with the option the client picked.
const FAKE_AGENT = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let promptId = null;
process.stdout.write("not json, ignored\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake" } } });
  else if (m.method === "session/new") send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
  else if (m.method === "session/prompt") {
    promptId = m.id;
    send({ id: "perm-1", method: "session/request_permission", params: { options: [{ optionId: "allow" }] } });
  } else if (m.id === "perm-1") {
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
    send({ id: promptId, result: { stopReason: "end_turn", picked: m.result.outcome.optionId } });
  }
});
`;

test("AcpClient speaks ACP: results, errors, agent requests and notifications", async () => {
  const client = new AcpClient({ command: process.execPath, args: ["-e", FAKE_AGENT], cwd: os.tmpdir() });
  try {
    const init = await client.initialize();
    assert.equal(init.agentInfo.name, "fake");

    await assert.rejects(client.request("session/new", { cwd: os.tmpdir(), mcpServers: [] }), (error) => {
      assert.ok(error instanceof AcpError);
      assert.equal(error.code, ACP_AUTH_REQUIRED);
      return true;
    });

    /** @type {import("#server/gemini-acp-client").AcpNotification[]} */
    const notes = [];
    client.on("notification", (/** @type {import("#server/gemini-acp-client").AcpNotification} */ note) => {
      notes.push(note);
    });
    client.on("request", (
      /** @type {string} */ method,
      /** @type {unknown} */ _params,
      /** @type {import("#server/gemini-acp-client").AcpResponder} */ respond,
    ) => {
      assert.equal(method, "session/request_permission");
      respond({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
    });
    const result = await client.request("session/prompt", { sessionId: "s", prompt: [] }, 0);
    assert.deepEqual(result, { stopReason: "end_turn", picked: "allow" });
    assert.deepEqual(notes, [{
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    }]);
  } finally {
    await client.stop();
  }
  await assert.rejects(client.request("initialize", {}), /not running/);
});
