const assert = require("node:assert/strict");
const test = require("node:test");

const { createInteractiveRequestId } = require("../dist/interactive-request-id");
const { repairTranscriptIdentityCollisions } = require("../dist/transcript-repair");

test("interactive request ids remain unique across reconstructed callers", () => {
  const ids = new Set(Array.from({ length: 100 }, () => createInteractiveRequestId("codex_elicit")));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^codex_elicit_[0-9a-f-]{36}$/);
});

test("repairs a reset question id without leaving a poisoned cached sequence", () => {
  const repaired = repairTranscriptIdentityCollisions([
    {
      role: "question",
      content: "Old approval",
      questionId: "codex_elicit_1",
      questions: [{ question: "Old approval" }],
      answered: true,
      timestamp: "2026-07-17T17:05:48.000Z",
      entryId: "shared-entry",
      sessionSeq: 10,
      revision: 2,
    },
    {
      role: "question",
      content: "New approval",
      questionId: "codex_elicit_1",
      questions: [{ question: "New approval" }],
      timestamp: "2026-07-20T18:57:28.000Z",
      entryId: "shared-entry",
      sessionSeq: 10,
      revision: 2,
    },
    {
      role: "assistant",
      content: "Before the new approval",
      timestamp: "2026-07-20T18:57:27.000Z",
      entryId: "assistant-before",
      sessionSeq: 11,
      revision: 1,
    },
    {
      role: "user",
      content: "After the new approval",
      timestamp: "2026-07-20T19:00:42.000Z",
      entryId: "user-after",
      sessionSeq: 12,
      revision: 1,
    },
  ]);

  assert.equal(repaired.changed, true);
  assert.equal(repaired.rebased, true);
  assert.equal(repaired.collisions, 1);
  assert.equal(repaired.rekeyedQuestions, 1);
  assert.equal(repaired.entries.length, 4);
  assert.ok(repaired.entries.every((entry) => entry.sessionSeq > 12));
  assert.equal(new Set(repaired.entries.map((entry) => entry.sessionSeq)).size, 4);
  assert.equal(new Set(repaired.entries.map((entry) => entry.entryId)).size, 4);
  assert.equal(new Set(repaired.entries.filter((entry) => entry.role === "question").map((entry) => entry.questionId)).size, 2);
  assert.equal(repaired.entries.find((entry) => entry.content === "New approval").answered, true);
  assert.equal(repaired.entries.find((entry) => entry.content === "New approval").status, "interrupted");
  assert.deepEqual(
    repaired.entries.map((entry) => entry.content),
    ["Old approval", "Before the new approval", "New approval", "After the new approval"],
  );
});

test("collapses lifecycle revisions of the same persisted card", () => {
  const repaired = repairTranscriptIdentityCollisions([
    {
      role: "secure_input",
      content: "Need token",
      questionId: "secure_abc",
      status: "pending",
      answered: false,
      toolInput: { label: "Token", reason: "Need token", scope: "session" },
      timestamp: "2026-07-20T12:00:00.000Z",
      entryId: "secure-entry",
      sessionSeq: 4,
      revision: 1,
    },
    {
      role: "secure_input",
      content: "Need token",
      questionId: "secure_abc",
      status: "saved",
      answered: true,
      toolInput: { label: "Token", reason: "Need token", scope: "session" },
      timestamp: "2026-07-20T12:01:00.000Z",
      entryId: "secure-entry",
      sessionSeq: 4,
      revision: 1,
    },
  ]);

  assert.equal(repaired.rebased, true);
  assert.equal(repaired.collapsed, 1);
  assert.equal(repaired.entries.length, 1);
  assert.equal(repaired.entries[0].status, "saved");
  assert.equal(repaired.entries[0].answered, true);
  assert.ok(repaired.entries[0].sessionSeq > 4);
});

test("rekeys repeated counter ids even when two distinct prompts have identical text", () => {
  const repaired = repairTranscriptIdentityCollisions([
    {
      role: "question",
      content: "Allow GitHub to create a pull request?",
      questionId: "codex_elicit_1",
      questions: [{ question: "Allow GitHub to create a pull request?" }],
      timestamp: "2026-07-14T16:41:51.000Z",
      entryId: "first-question",
      sessionSeq: 4,
      revision: 1,
    },
    {
      role: "question",
      content: "Allow GitHub to create a pull request?",
      questionId: "codex_elicit_1",
      questions: [{ question: "Allow GitHub to create a pull request?" }],
      timestamp: "2026-07-14T17:45:38.000Z",
      entryId: "second-question",
      sessionSeq: 9,
      revision: 1,
    },
  ]);

  assert.equal(repaired.rebased, false);
  assert.equal(repaired.rekeyedQuestions, 1);
  assert.equal(repaired.entries.length, 2);
  assert.deepEqual(repaired.entries.map((entry) => entry.sessionSeq), [4, 9]);
  assert.equal(new Set(repaired.entries.map((entry) => entry.questionId)).size, 2);
});
