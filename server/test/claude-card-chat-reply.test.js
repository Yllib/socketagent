const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
require("./test-data-dir");
const { ClaudeSession } = require("#server/claude-session");
const { positionSessionMessage } = require("#server/session-store");

// A Claude session mid-turn, so injectMessage takes the running path.
function runningSession() {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  /** @type {string[]} */
  const streamed = [];
  const value = new ClaudeSession({ readyState: 1, send() {} }, process.cwd(), []);
  value.sessionId = `card-reply-${crypto.randomUUID()}`;
  value.send = (/** @type {import("#server/protocol").ServerMessage} */ message) => sent.push(positionSessionMessage(value.getSessionId(), message));
  Object.assign(value, {
    _isRunning: true,
    activeQuery: { streamInput: async () => { streamed.push("message"); } },
  });
  return { value, sent, streamed };
}
/** @returns {Promise<void>} */
const tick = () => new Promise(resolve => setImmediate(resolve));

const cards = [
  {
    name: "question",
    open: (/** @type {ClaudeSession} */ value) => value._askClaudeQuestion({
      questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] }],
    }),
    skipped: "didn't pick an answer",
  },
  {
    name: "plan review",
    open: (/** @type {ClaudeSession} */ value) => value._requestClaudePlanApproval("1. Do it", { plan: "1. Do it" }),
    skipped: "didn't approve or reject the plan",
  },
  {
    name: "tool approval",
    open: (/** @type {ClaudeSession} */ value) => value._requestClaudeToolApproval("Bash", { command: "rm -rf /tmp/x/*" }, undefined, "Dangerous rm"),
    skipped: "didn't approve this tool call",
  },
];

for (const card of cards) {
  test(`a chat message answers an open ${card.name} card`, async () => {
    const { value, sent, streamed } = runningSession();
    const waiting = card.open(value);
    await tick();
    const question = sent.find(message => message.type === "question");
    assert.ok(question);

    await value.injectMessage("Use green instead", "now", "m1", { replyToOpenCards: true });
    const decision = await waiting;
    assert.equal(decision.behavior, "deny");
    assert.ok("message" in decision);
    assert.match(decision.message, new RegExp(`The user ${card.skipped}`));
    assert.match(decision.message, /Use green instead$/);
    assert.equal(streamed.length, 0, "the message goes to the card, not the stream");
    const answered = sent.find(message => message.type === "question_answered");
    assert.ok(answered);
    assert.equal(answered.questionId, question.questionId);
    assert.deepEqual(Object.values(answered.answers), ["Replied in chat"]);
    assert.equal(value.pendingQuestions.size, 0);
  });
}

test("messages the user did not type leave the card open", async () => {
  const { value, sent } = runningSession();
  const waiting = value._askClaudeQuestion({ questions: [{ question: "Which color?", options: [{ label: "Red" }] }] });
  await tick();
  await value.injectMessage("Monitor output", "next");
  assert.equal(value.pendingQuestions.size, 1);

  const question = sent.find(message => message.type === "question");
  assert.ok(question);
  value.resolveQuestion(question.questionId, { "Which color?": "Red" });
  const decision = await waiting;
  assert.equal(decision.behavior, "allow");
  assert.ok("updatedInput" in decision);
  assert.deepEqual(decision.updatedInput.answers, { "Which color?": "Red" });
});

test("with no open card a chat message is injected as usual", async () => {
  const { value, streamed } = runningSession();
  await value.injectMessage("Keep going", "now", "m2", { replyToOpenCards: true });
  assert.equal(streamed.length, 1);
});

test("an open card records when it opened until it is answered", async () => {
  const { value, sent } = runningSession();
  assert.equal(value.oldestOpenCardAt, undefined);
  const before = Date.now();
  const waiting = value._askClaudeQuestion({ questions: [{ question: "Which color?", options: [{ label: "Red" }] }] });
  await tick();
  const openedAt = value.oldestOpenCardAt;
  assert.ok(openedAt !== undefined && openedAt >= before && openedAt <= Date.now());

  const question = sent.find(message => message.type === "question");
  assert.ok(question);
  value.resolveQuestion(question.questionId, { "Which color?": "Red" });
  await waiting;
  assert.equal(value.oldestOpenCardAt, undefined);
});
