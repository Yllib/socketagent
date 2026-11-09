const assert = require("node:assert/strict");
const test = require("node:test");
require("./test-data-dir");

const {
  appendHistory,
  getTranscriptViewPage,
  onHistoryChanged,
  recordUserPrompt,
} = require("#server/session-store");

test("the page starts where a resume would, pins its start, and grows with new rows", () => {
  const sessionId = "transcript-view-page";
  /** @type {string[]} */
  const changed = [];
  const stop = onHistoryChanged((id) => changed.push(id));
  for (let index = 0; index < 3; index++) {
    appendHistory(sessionId, { role: "assistant", content: `row ${index}`, timestamp: new Date().toISOString() });
  }
  stop();
  assert.ok(changed.filter((id) => id === sessionId).length >= 3, "every write reports its session");

  const first = getTranscriptViewPage(sessionId);
  assert.equal(first.rows.length, 3);
  assert.equal(first.offset, 0);
  assert.equal(first.fromSeq, first.rows[0].sessionSeq);

  appendHistory(sessionId, { role: "assistant", content: "row 3", timestamp: new Date().toISOString() });
  const second = getTranscriptViewPage(sessionId, first.fromSeq);
  assert.deepEqual(second.rows.map((row) => row.content), ["row 0", "row 1", "row 2", "row 3"]);

  const capped = getTranscriptViewPage(sessionId, first.fromSeq, 2);
  assert.deepEqual(capped.rows.map((row) => row.content), ["row 2", "row 3"]);
  assert.equal(capped.fromSeq, capped.rows[0].sessionSeq);
  assert.equal(capped.offset, 2);
});

test("a user row keeps the app's message ID", () => {
  const sessionId = "transcript-view-user";
  recordUserPrompt({ sessionId, content: "hello", uuid: "uuid-1", clientMessageId: "local-7" });
  const [row] = getTranscriptViewPage(sessionId).rows;
  assert.equal(row.clientMessageId, "local-7");
});
