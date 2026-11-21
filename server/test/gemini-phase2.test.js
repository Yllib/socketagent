const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");

const tempDir = path.join(os.tmpdir(), `socketagent-gemini-p2-${crypto.randomUUID()}`);
process.env.SOCKET_AGENT_DATA_DIR = tempDir;
fs.mkdirSync(tempDir, { recursive: true });

const { AcpClient } = require("#server/gemini-acp-client");
const {
  GeminiSession,
  buildAcpElicitationContent,
  extractAttachedImageBlocks,
  parseAcpElicitationQuestions,
} = require("#server/gemini-session");
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

test("parseAcpElicitationQuestions and buildAcpElicitationContent map single-select, multi-select, and Other answers", () => {
  const fields = parseAcpElicitationQuestions({
    message: "The agent has a question.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "string",
          title: "Pick a fruit",
          oneOf: [
            { const: "1", title: "(Recommended) Apple" },
            { const: "2", title: "Banana" },
          ],
        },
        q1_other: { type: "string", title: "Other" },
        q2: {
          type: "array",
          title: "Pick colors",
          items: {
            oneOf: [
              { const: "r", title: "Red" },
              { const: "b", title: "Blue" },
            ],
          },
        },
        q2_other: { type: "string", title: "Other" },
      },
    },
  });

  assert.equal(fields.length, 2);
  assert.equal(fields[0].question, "Pick a fruit");
  assert.equal(fields[0].otherKey, "q1_other");
  assert.equal(fields[1].multiSelect, true);

  assert.deepEqual(
    buildAcpElicitationContent(fields, {
      "Pick a fruit": "(Recommended) Apple",
      "Pick colors": "Red, Green",
    }),
    { q1: "1", q2: ["r"], q2_other: "Green" },
  );

  assert.deepEqual(
    buildAcpElicitationContent(fields, { "Pick a fruit": "Mango" }),
    { q1_other: "Mango" },
  );
});

test("extractAttachedImageBlocks reads image attachments and skips non-images or missing files", () => {
  const imgPath = path.join(tempDir, "shot.png");
  const txtPath = path.join(tempDir, "notes.txt");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(imgPath, pngBytes);
  fs.writeFileSync(txtPath, "plain text");

  const blocks = extractAttachedImageBlocks(
    `Look at this\n[Attached file: ${imgPath}]\n[Attached file: ${txtPath}]\n[Attached file: ${path.join(tempDir, "missing.png")}]`,
  );
  assert.deepEqual(blocks, [{
    type: "image",
    data: pngBytes.toString("base64"),
    mimeType: "image/png",
  }]);
});

test("Gemini forwards additionalDirectories, surfaces commands + elicitation questions, and enforces disallowedTools", async () => {
  const FAKE_AGENT = `
    const rl = require("readline").createInterface({ input: process.stdin });
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    let promptId = null;
    let extraDirsSeen = null;
    let permDecision = null;
    let elicitResult = null;
    rl.on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "initialize") {
        send({ id: m.id, result: { protocolVersion: 1 } });
      } else if (m.method === "session/new") {
        extraDirsSeen = m.params.additionalDirectories || null;
        send({ id: m.id, result: { sessionId: "gemini-p2-session", configOptions: [] } });
        send({
          method: "session/update",
          params: {
            sessionId: "gemini-p2-session",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "plan", description: "Plan carefully" }],
            },
          },
        });
      } else if (m.method === "session/prompt") {
        promptId = m.id;
        send({
          id: "perm-bash",
          method: "session/request_permission",
          params: {
            toolCall: { name: "run_command", kind: "execute", rawInput: { CommandLine: "echo no" } },
            options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
          },
        });
      } else if (m.id === "perm-bash") {
        permDecision = m.result.outcome.optionId;
        send({
          id: "elicit-1",
          method: "elicitation/create",
          params: {
            sessionId: "gemini-p2-session",
            mode: "form",
            message: "Choose one",
            requestedSchema: {
              type: "object",
              properties: {
                q1: {
                  type: "string",
                  title: "Favorite fruit?",
                  oneOf: [{ const: "1", title: "Apple" }, { const: "2", title: "Banana" }],
                },
                q1_other: { type: "string", title: "Other" },
              },
            },
          },
        });
      } else if (m.id === "elicit-1") {
        elicitResult = m.result;
        send({
          method: "session/update",
          params: {
            sessionId: "gemini-p2-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: JSON.stringify({ extraDirsSeen, permDecision, elicitResult }) },
            },
          },
        });
        send({ id: promptId, result: { stopReason: "end_turn" } });
      }
    });
  `;

  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  await session.setPermissionMode("bypassPermissions", { recordHistory: false });
  session.setDisallowedTools(["Bash"]);
  session.setAdditionalDirectories(["/var/tmp"]);
  assert.deepEqual(session.getAgentSettings().additionalDirectories, ["/var/tmp"]);

  const client = new AcpClient({ command: process.execPath, args: ["-e", FAKE_AGENT], cwd: process.cwd() });
  client.on("notification", (/** @type {import("#server/gemini-acp-client").AcpNotification} */ note) => {
    session.handleNotification(note);
  });
  client.on("request", (
    /** @type {string} */ method,
    /** @type {unknown} */ params,
    /** @type {import("#server/gemini-acp-client").AcpResponder} */ respond,
  ) => {
    void session.handleRequest(method, params, respond);
  });
  await client.initialize();
  session.client = client;

  try {
    const runPromise = session.runQuery("test phase 2");

    // Wait for the elicitation QuestionCard to be emitted and answer it.
    const deadline = Date.now() + 5_000;
    /** @type {import("#server/protocol").ServerMessage | undefined} */
    let questionMsg;
    while (!questionMsg && Date.now() < deadline) {
      questionMsg = sent.find((m) => m.type === "question");
      if (!questionMsg) await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(questionMsg && questionMsg.type === "question");
    assert.equal(questionMsg.questions[0].question, "Favorite fruit?");
    assert.equal(session.resolveQuestion(questionMsg.questionId, { "Favorite fruit?": "Banana" }), true);

    await runPromise;

    const commands = sent.find((m) => m.type === "supported_commands");
    assert.equal(commands?.commands[0]?.name, "plan");
    assert.equal(commands?.commands[0]?.agent, "gemini");

    const result = sent.find((m) => m.type === "result");
    const parsed = z.object({
      extraDirsSeen: z.array(z.string()).nullable(),
      permDecision: z.string().nullable(),
      elicitResult: z.object({
        action: z.string(),
        content: z.record(z.string(), z.unknown()),
      }),
    }).parse(JSON.parse(result?.content || "{}"));
    assert.deepEqual(parsed.extraDirsSeen, ["/var/tmp"]);
    assert.equal(parsed.permDecision, "reject");
    assert.deepEqual(parsed.elicitResult, { action: "accept", content: { q1: "2" } });
  } finally {
    await session.dispose();
  }
});
