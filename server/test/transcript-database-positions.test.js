const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TranscriptDatabase } = require("#server/transcript-database");

/** @param {(database: import("#server/transcript-database").TranscriptDatabase) => void} body */
function withDatabase(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-positions-"));
  const database = new TranscriptDatabase(path.join(dir, "transcripts.sqlite"));
  try {
    body(database);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {number} seq @param {Record<string, unknown>} [fields] */
function row(seq, fields = {}) {
  return {
    entry: { entryId: `entry-${seq}`, sessionSeq: seq, revision: 1, role: "assistant", content: `reply ${seq}`, ...fields },
    positionKey: null,
  };
}

// Sequence gaps make positions differ from sequence numbers, which is what
// would expose a page counted from the wrong end.
const SEQS = [1, 2, 4, 5, 7, 8, 10, 11, 13, 14];

test("pages and positions agree whether counted from the start or the end", () => {
  withDatabase((database) => {
    database.replace("session", SEQS.map((seq) => row(seq)));
    /** @param {number} offset @param {number} limit */
    const seqs = (offset, limit) => database.getPage("session", offset, limit).map((entry) => entry.sessionSeq);
    for (let offset = 0; offset <= SEQS.length; offset++) {
      for (const limit of [1, 3, 20]) {
        assert.deepEqual(seqs(offset, limit), SEQS.slice(offset, offset + limit), `offset=${offset} limit=${limit}`);
      }
    }
    assert.equal(
      database.windowDigest("session", 7, 3),
      database.windowDigest("session", 7, 10),
      "a window past the end covers the same rows",
    );
    assert.notEqual(database.windowDigest("session", 6, 3), database.windowDigest("session", 7, 3));
    SEQS.forEach((seq, index) => assert.equal(database.offsetForSessionSeq("session", seq), index));
    assert.equal(database.offsetForSessionSeq("session", 3), undefined);
  });
});

test("pending tool calls are calls with no result for their tool use id", () => {
  withDatabase((database) => {
    database.replace("session", [
      row(1, { role: "tool_call", toolName: "Bash", toolUseId: "done" }),
      row(2, { role: "tool_result", toolUseId: "done" }),
      row(3, { role: "tool_call", toolName: "Read", toolUseId: "open" }),
      row(4, { role: "tool_image", toolUseId: "open" }),
    ]);
    assert.deepEqual(database.pendingToolCalls("session").map((entry) => entry.toolUseId), ["open"]);
  });
});

test("the Claude task backfill marker follows a remapped session", () => {
  withDatabase((database) => {
    database.replace("old", [row(1)]);
    assert.equal(database.claudeTasksBackfilled("old"), false);
    database.markClaudeTasksBackfilled("old");
    database.remapSession("old", "new");
    assert.equal(database.claudeTasksBackfilled("new"), true);
  });
});
