const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-interactions-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  appendHistory,
  getHistory,
  markQuestionAnswered,
  markSecureInputRequestResolved,
} = require("../dist/session-store");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("question completion persists the safe answer and advances its revision", () => {
  const sessionId = "answered-question";
  const created = appendHistory(sessionId, {
    role: "question",
    content: "",
    questionId: "q-1",
    questions: [{
      question: "Deploy now?",
      options: [{ label: "Yes" }, { label: "No" }],
    }],
    timestamp: new Date().toISOString(),
  });

  markQuestionAnswered(sessionId, "q-1", { "Deploy now?": "Yes" });
  const [answered] = getHistory(sessionId);

  assert.equal(answered.answered, true);
  assert.deepEqual(answered.answers, { "Deploy now?": "Yes" });
  assert.ok(answered.revision > created.revision);

  const completedRevision = answered.revision;
  markQuestionAnswered(sessionId, "q-1", { "Deploy now?": "Yes" });
  assert.equal(getHistory(sessionId)[0].revision, completedRevision);
});

test("URL elicitation completion is durable and retains its action", () => {
  const sessionId = "answered-elicitation";
  appendHistory(sessionId, {
    role: "elicitation_url",
    content: "Authenticate",
    questionId: "elicit-1",
    mcpServerName: "Example",
    url: "https://example.test/auth",
    timestamp: new Date().toISOString(),
  });

  markQuestionAnswered(sessionId, "elicit-1", { action: "cancel" });
  const [answered] = getHistory(sessionId);

  assert.equal(answered.answered, true);
  assert.deepEqual(answered.answers, { action: "cancel" });
});

test("secure-input completion advances status without persisting an answer", () => {
  const sessionId = "answered-secure-input";
  const created = appendHistory(sessionId, {
    role: "secure_input",
    content: "Needed for deployment",
    questionId: "secure-1",
    answered: false,
    status: "pending",
    toolInput: {
      label: "DEPLOY_TOKEN",
      status: "pending",
    },
    timestamp: new Date().toISOString(),
  });

  markSecureInputRequestResolved(sessionId, "secure-1", "saved");
  const [answered] = getHistory(sessionId);

  assert.equal(answered.answered, true);
  assert.equal(answered.status, "saved");
  assert.equal(answered.toolInput.status, "saved");
  assert.equal(answered.answers, undefined);
  assert.ok(answered.revision > created.revision);
});
