const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-secure-async-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const { handleRequestSecureInputTool, setSessionReporter } = require("#server/app-tool-handlers");
const { completeSecureInputRequest, cancelSecureInputRequest } = require("#server/secure-input-store");

/** @typedef {import("#server/protocol").ServerMessage} ServerMessage */

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/**
 * @param {ServerMessage[]} sent
 * @returns {import("#server/app-tool-handlers").AppToolContext}
 */
function context(sent) {
  return {
    getSessionId: () => "session-async",
    getCwd: () => dataDir,
    send: (message) => sent.push(message),
    getTtsEngine: () => "system",
    getKokoroVoice: () => "af_heart",
    getKokoroSpeed: () => 1,
  };
}

/** @returns {Promise<{ sessionId: string, text: string }>} */
function nextReport() {
  return new Promise((resolve) => {
    setSessionReporter(async (sessionId, text) => resolve({ sessionId, text }));
  });
}

/** @param {ServerMessage[]} sent */
function secureInputCard(sent) {
  for (const message of sent) if (message.type === "secure_input_request") return message;
  throw new Error("No secure input card was sent");
}

test("returns before the user answers, then reports the saved file path", async () => {
  /** @type {ServerMessage[]} */
  const sent = [];
  const result = await handleRequestSecureInputTool(context(sent), { label: "API_TOKEN" });
  assert.match(result.content[0].text, /does not wait/);
  const card = secureInputCard(sent);

  const report = nextReport();
  const saved = completeSecureInputRequest(card.requestId, "token-value-must-not-leak");
  const { sessionId, text } = await report;
  assert.equal(sessionId, "session-async");
  assert.match(text, /^\[Secure input\] The user saved "API_TOKEN"/);
  assert.ok(text.includes(saved.filePath));
  assert.ok(!text.includes("token-value-must-not-leak"));
});

test("reports a declined card", async () => {
  /** @type {ServerMessage[]} */
  const sent = [];
  await handleRequestSecureInputTool(context(sent), { label: "DB_PASSWORD" });
  const card = secureInputCard(sent);

  const report = nextReport();
  cancelSecureInputRequest(card.requestId);
  assert.equal((await report).text, '[Secure input] The user declined to enter "DB_PASSWORD".');
});
