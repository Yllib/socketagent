const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { TranscriptDatabase } = require("../dist/transcript-database");

test("portable transcript search works when SQLite has no FTS5 module", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-search-fallback-"));
  const db = new TranscriptDatabase(path.join(dir, "transcripts.sqlite"), { disableFts: true });
  try {
    db.replace("session-1", [
      {
        entry: {
          entryId: "entry-1",
          sessionSeq: 1,
          revision: 1,
          role: "user",
          content: "Plan the marina accounting transition",
          timestamp: "2026-08-01T10:00:00.000Z",
        },
        positionKey: "user-1",
      },
      {
        entry: {
          entryId: "entry-2",
          sessionSeq: 2,
          revision: 1,
          role: "assistant",
          content: "Use customer deposits before delivery",
          timestamp: "2026-08-01T10:00:01.000Z",
        },
        positionKey: "assistant-1",
      },
    ]);

    assert.deepEqual(
      db.search("session-1", { query: "customer deposits" }).map((hit) => hit.entryId),
      ["entry-2"],
    );

    db.upsert("session-1", {
      entryId: "entry-3",
      sessionSeq: 3,
      revision: 1,
      role: "tool_result",
      toolName: "Bash",
      content: "all tests passed",
      timestamp: "2026-08-01T10:00:02.000Z",
    }, "tool-1");
    assert.equal(db.search("session-1", { query: "tests", toolName: "Bash" })[0].entryId, "entry-3");

    db.deleteSession("session-1");
    assert.equal(db.search("session-1", { query: "customer" }).length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
