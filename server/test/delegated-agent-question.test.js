const assert = require("node:assert/strict");
const test = require("node:test");

const { answersForQuestion, delegatedQuestionPrompt } = require("../dist/delegated-agent-question.js");

const record = {
  delegationId: "d1",
  supervisorSessionId: "parent",
  childSessionId: "child",
  backend: "claude",
  cwd: "/tmp",
  label: "Help reference",
  status: "running",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  runs: [],
};
const approval = {
  type: "question",
  questionId: "approval_1",
  sessionId: "child",
  questions: [{
    question: "Allow Bash?\n{\"command\":\"ls\"}",
    header: "Tool approval",
    options: [{ label: "Approve" }, { label: "Decline" }],
    multiSelect: false,
  }],
};

test("the report names the child, the question and how to answer it", () => {
  const prompt = delegatedQuestionPrompt(record, approval);
  assert.match(prompt, /question_id="approval_1"/);
  assert.match(prompt, /"Help reference" is blocked/);
  assert.match(prompt, /Question 1 \(Tool approval\): Allow Bash\?/);
  assert.match(prompt, /Options: Approve \| Decline/);
  assert.match(prompt, /action=answer, session_id="child"/);
});

test("answers given in order map to the question text", () => {
  assert.deepEqual(answersForQuestion(approval, ["Approve"]), { [approval.questions[0].question]: "Approve" });
  assert.throws(() => answersForQuestion(approval, []), /Give 1 answer/);
});
