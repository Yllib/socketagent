const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-secure-inventory-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  listAvailableSecureInputs,
  requestSecureInput,
  saveSecureInput,
  secureInputInventoryForAgent,
  completeSecureInputRequest,
} = require("../dist/secure-input-store");
const { appendHistory, getHistory } = require("../dist/session-store");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("lists only metadata for secrets available to the current context", () => {
  const cwd = path.join(dataDir, "project-a");
  const otherCwd = path.join(dataDir, "project-b");
  const sessionId = "session-a";

  const globalSecret = saveSecureInput({
    label: "GLOBAL_TOKEN",
    value: "global-value-must-not-leak",
    scope: "global",
  });
  const projectSecret = saveSecureInput({
    label: "PROJECT_PASSWORD",
    value: "project-value-must-not-leak",
    scope: "project",
    cwd,
  });
  saveSecureInput({
    label: "OTHER_PROJECT_PASSWORD",
    value: "other-project-value-must-not-leak",
    scope: "project",
    cwd: otherCwd,
  });
  const sessionSecret = saveSecureInput({
    label: "SESSION_KEY",
    value: "session-value-must-not-leak",
    scope: "session",
    sessionId,
    cwd,
  });
  saveSecureInput({
    label: "OTHER_SESSION_KEY",
    value: "other-session-value-must-not-leak",
    scope: "session",
    sessionId: "session-b",
    cwd,
  });

  const available = listAvailableSecureInputs(sessionId, cwd);
  assert.deepEqual(
    new Set(available.map((entry) => entry.label)),
    new Set(["GLOBAL_TOKEN", "PROJECT_PASSWORD", "SESSION_KEY"]),
  );
  assert.ok(available.every((entry) => !Object.hasOwn(entry, "value")));
  assert.ok(available.some((entry) => entry.filePath === globalSecret.filePath));
  assert.ok(available.some((entry) => entry.filePath === projectSecret.filePath));
  assert.ok(available.some((entry) => entry.filePath === sessionSecret.filePath));

  const inventory = secureInputInventoryForAgent(sessionId, cwd);
  assert.match(inventory, /GLOBAL_TOKEN/);
  assert.match(inventory, /PROJECT_PASSWORD/);
  assert.match(inventory, /SESSION_KEY/);
  assert.doesNotMatch(inventory, /OTHER_PROJECT_PASSWORD/);
  assert.doesNotMatch(inventory, /OTHER_SESSION_KEY/);
  assert.doesNotMatch(inventory, /must-not-leak/);
});

test("emits metadata-only lifecycle states for a secure input card", async () => {
  const sent = [];
  const states = [];
  const pending = requestSecureInput(
    (message) => sent.push(message),
    {
      label: "HISTORY_TEST_PASSWORD",
      reason: "Verify card history",
      scope: "session",
      timeoutSeconds: 30,
    },
    "history-session",
    dataDir,
    (message, status) => states.push({ message, status }),
  );

  const requestId = sent[0].requestId;
  completeSecureInputRequest(requestId, "history-secret-must-not-leak");
  await pending;

  assert.deepEqual(states.map((entry) => entry.status), ["pending", "saved"]);
  assert.ok(states.every((entry) => JSON.stringify(entry).includes("HISTORY_TEST_PASSWORD")));
  assert.ok(states.every((entry) => !JSON.stringify(entry).includes("must-not-leak")));
});

test("closes a history card whose in-memory request was interrupted", () => {
  appendHistory("interrupted-session", {
    role: "secure_input",
    content: "Enter a credential",
    questionId: "secure_no_longer_pending",
    answered: false,
    status: "pending",
    toolInput: {
      label: "INTERRUPTED_PASSWORD",
      envHint: "INTERRUPTED_PASSWORD",
      scope: "session",
      status: "pending",
    },
    timestamp: new Date().toISOString(),
  });

  const [card] = getHistory("interrupted-session");
  assert.equal(card.role, "secure_input");
  assert.equal(card.status, "interrupted");
  assert.equal(card.answered, true);
  assert.equal(card.toolInput.status, "interrupted");
});
