const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPluginAnswerAcknowledgement,
} = require("../dist/plugin-answer");

test("plugin answers are private by default", () => {
  const acknowledgement = createPluginAnswerAcknowledgement(
    "outlook_auth_1",
    "session-1",
    { handled: true },
  );

  assert.deepEqual(acknowledgement, {
    type: "question_answered",
    questionId: "outlook_auth_1",
    sessionId: "session-1",
  });
  assert.equal("answers" in acknowledgement, false);
});

test("only an explicit sanitized plugin answer projection is acknowledged", () => {
  const publicAnswers = { status: "connected" };
  const acknowledgement = createPluginAnswerAcknowledgement(
    "integration_question_1",
    undefined,
    { handled: true, publicAnswers },
  );

  assert.deepEqual(acknowledgement, {
    type: "question_answered",
    questionId: "integration_question_1",
    answers: { status: "connected" },
  });
  assert.notEqual(acknowledgement.answers, publicAnswers);
});
