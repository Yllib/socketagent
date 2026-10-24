const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
require("./test-data-dir");
const { ClaudeSession } = require("#server/claude-session");
const { positionSessionMessage } = require("#server/session-store");

function session() {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const value = new ClaudeSession({ readyState: 1, send() {} }, process.cwd(), []);
  value.sessionId = `super-yolo-${crypto.randomUUID()}`;
  value.send = (/** @type {import("#server/protocol").ServerMessage} */ message) => sent.push(positionSessionMessage(value.getSessionId(), message));
  return { value, sent };
}
/** @returns {Promise<void>} */
const tick = () => new Promise(resolve => setImmediate(resolve));

const rmInput = { command: "rm -rf /tmp/example/after/*" };
const rmReason = "Dangerous rm operation on statically-unresolvable target: /tmp/example/after/*";

test("super yolo allows an SDK escalation without a card; other modes still ask", async () => {
  const { value, sent } = session();
  await value.setPermissionMode("superYolo");
  assert.equal(value.permissionMode, "superYolo");
  const decision = await value._requestClaudeToolApproval("Bash", rmInput, undefined, rmReason);
  assert.deepEqual(decision, { behavior: "allow", updatedInput: rmInput });
  assert.equal(sent.filter(message => message.type === "question").length, 0);
  assert.equal(value.pendingQuestions.size, 0);

  for (const mode of ["bypassPermissions", "default", "acceptEdits", "plan"]) {
    const asking = session();
    await asking.value.setPermissionMode(mode);
    const waiting = asking.value._requestClaudeToolApproval("Bash", rmInput, undefined, rmReason);
    await tick();
    const question = asking.sent.find(message => message.type === "question");
    assert.ok(question, `${mode} sends a tool approval card`);
    asking.value.resolveQuestion(question.questionId, { [question.questions[0].question]: "Approve" });
    assert.equal((await waiting).behavior, "allow");
  }
});

test("super yolo runs the SDK in bypassPermissions and shows through a plan excursion", async () => {
  const { value } = session();
  await value.setPermissionMode("superYolo");
  assert.equal(value._permissionMode, "bypassPermissions");
  // EnterPlanMode: the SDK reports plan, the app sees plan, escalations ask again.
  value._permissionMode = "plan";
  assert.equal(value.permissionMode, "plan");
  // ExitPlanMode returns the SDK to bypassPermissions; super yolo resumes.
  value._permissionMode = "bypassPermissions";
  assert.equal(value.permissionMode, "superYolo");
  // Picking plain yolo leaves super yolo for good.
  await value.setPermissionMode("bypassPermissions");
  assert.equal(value.permissionMode, "bypassPermissions");
  value._permissionMode = "plan";
  value._permissionMode = "bypassPermissions";
  assert.equal(value.permissionMode, "bypassPermissions");
});

test("switching to super yolo approves the tool card already waiting on the phone", async () => {
  const { value, sent } = session();
  await value.setPermissionMode("bypassPermissions");
  const waiting = value._requestClaudeToolApproval("Bash", rmInput, undefined, rmReason);
  await tick();
  const question = sent.find(message => message.type === "question");
  assert.ok(question);
  await value.setPermissionMode("superYolo");
  assert.equal((await waiting).behavior, "allow");
  const answered = sent.find(message => message.type === "question_answered" && message.questionId === question.questionId);
  assert.ok(answered && answered.type === "question_answered");
  assert.equal(Object.values(answered.answers)[0], "Approve");
  assert.equal(value.pendingQuestions.size, 0);
});

test("restoring super yolo without history leaves no transcript card", async () => {
  const { value } = session();
  const { getHistory } = require("#server/session-store");
  await value.setPermissionMode("superYolo", { recordHistory: false });
  assert.equal(value.permissionMode, "superYolo");
  assert.equal(getHistory(value.sessionId).filter(entry => entry.role === "permission_mode").length, 0);
  await value.setPermissionMode("superYolo");
  assert.equal(getHistory(value.sessionId).filter(entry => entry.role === "permission_mode").length, 1);
});
