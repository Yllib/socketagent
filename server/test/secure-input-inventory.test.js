const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-secure-inventory-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  listAvailableSecureInputs,
  createSecureInputInventoryMessage,
  requestSecureInput,
  saveSecureInput,
  secureInputInventoryForAgent,
  completeSecureInputRequest,
  completeSecureInputRequestWithSavedSecret,
  deleteSecureInput,
  replaceSecureInput,
} = require("../dist/secure-input-store");
const {
  appendHistory,
  getHistory,
  getPersistedSecureInputRequest,
  markSecureInputRequestResolved,
} = require("../dist/session-store");

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

test("correlates inventory replies without exposing secret values", () => {
  const cwd = path.join(dataDir, "correlated-project");
  saveSecureInput({
    label: "CORRELATED_TOKEN",
    value: "correlated-value-must-not-leak",
    scope: "project",
    cwd,
  });

  const message = createSecureInputInventoryMessage(
    "inventory-request-1",
    "correlated-session",
    cwd,
  );

  assert.equal(message.type, "secret_inventory");
  assert.equal(message.requestId, "inventory-request-1");
  assert.equal(message.sessionId, "correlated-session");
  assert.ok(message.secrets.some((secret) => secret.label === "CORRELATED_TOKEN"));
  assert.doesNotMatch(JSON.stringify(message), /correlated-value-must-not-leak/);
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

test("keeps a persisted secure-input card actionable without a live promise", () => {
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
  assert.equal(card.status, "pending");
  assert.equal(card.answered, false);
  assert.equal(card.toolInput.status, "pending");

  const recovered = getPersistedSecureInputRequest(
    "interrupted-session",
    "secure_no_longer_pending",
  );
  assert.equal(recovered.label, "INTERRUPTED_PASSWORD");
  markSecureInputRequestResolved(
    "interrupted-session",
    "secure_no_longer_pending",
    "saved",
  );
  const [resolved] = getHistory("interrupted-session");
  assert.equal(resolved.status, "saved");
  assert.equal(resolved.answered, true);
});

test("completes a live request with stored metadata without reading its value", async () => {
  const cwd = path.join(dataDir, "stored-request-project");
  const stored = saveSecureInput({
    label: "EXISTING_PASSWORD",
    value: "stored-value-must-not-cross-the-wire",
    scope: "project",
    cwd,
  });
  const sent = [];
  const pending = requestSecureInput(
    (message) => sent.push(message),
    { label: "EXISTING_PASSWORD", scope: "project" },
    "stored-request-session",
    cwd,
  );
  const requestId = sent[0].requestId;

  const completed = completeSecureInputRequestWithSavedSecret(
    requestId,
    stored.secretId,
  );
  const resolved = await pending;

  assert.equal(completed.secretId, stored.secretId);
  assert.equal(resolved.filePath, stored.filePath);
  assert.doesNotMatch(JSON.stringify(sent), /stored-value-must-not-cross-the-wire/);
});

test("replaces a value without exposing the previous value in metadata", () => {
  const cwd = path.join(dataDir, "managed-project");
  const saved = saveSecureInput({
    label: "MANAGED_PASSWORD",
    value: "old-managed-value",
    scope: "project",
    cwd,
  });

  const replaced = replaceSecureInput({
    secretId: saved.secretId,
    value: "new-managed-value",
    label: "RENAMED_PASSWORD",
    envHint: "RENAMED_PASSWORD",
    cwd,
  });

  assert.equal(replaced.secretId, saved.secretId);
  assert.equal(replaced.label, "RENAMED_PASSWORD");
  assert.equal(fs.readFileSync(saved.filePath, "utf8"), "new-managed-value");
  const inventory = listAvailableSecureInputs(undefined, cwd);
  const metadata = inventory.find((entry) => entry.secretId === saved.secretId);
  assert.equal(metadata.label, "RENAMED_PASSWORD");
  assert.ok(metadata.updatedAt);
  assert.doesNotMatch(JSON.stringify(metadata), /managed-value/);
});

test("deletes only secrets available in the supplied context", () => {
  const cwd = path.join(dataDir, "delete-project");
  const otherCwd = path.join(dataDir, "other-delete-project");
  const saved = saveSecureInput({
    label: "DELETE_ME",
    value: "delete-value",
    scope: "project",
    cwd,
  });

  assert.equal(deleteSecureInput(saved.secretId, undefined, otherCwd), false);
  assert.equal(fs.existsSync(saved.filePath), true);
  assert.equal(deleteSecureInput(saved.secretId, undefined, cwd), true);
  assert.equal(fs.existsSync(saved.filePath), false);
  assert.equal(
    listAvailableSecureInputs(undefined, cwd).some(
      (entry) => entry.secretId === saved.secretId,
    ),
    false,
  );
});
