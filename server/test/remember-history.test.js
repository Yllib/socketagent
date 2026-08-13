const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-remember-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  appendHistory,
  deleteSessionArtifacts,
  getHistory,
  getHistoryPage,
  rememberHistoryContext,
  rememberSearchHistory,
} = require("../dist/session-store");
const { handleRememberTool } = require("../dist/app-tool-handlers");

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("legacy JSON migrates once and later appends use SQLite without rewriting it", () => {
  const sessionId = "legacy-memory-session";
  const historyDir = path.join(dataDir, "history");
  const historyPath = path.join(historyDir, `${sessionId}.json`);
  fs.mkdirSync(historyDir, { recursive: true });
  const legacy = [
    { role: "user", content: "Discuss the blue accounting migration", timestamp: "2026-08-01T10:00:00.000Z" },
    { role: "assistant", content: "We should stop deferring revenue", timestamp: "2026-08-01T10:00:01.000Z" },
  ];
  fs.writeFileSync(historyPath, JSON.stringify(legacy));
  const before = fs.readFileSync(historyPath, "utf8");

  const migrated = getHistory(sessionId);
  assert.equal(migrated.length, 2);
  assert.deepEqual(migrated.map((entry) => entry.sessionSeq), [1, 2]);
  assert.ok(fs.existsSync(path.join(historyDir, "transcripts.sqlite")));

  appendHistory(sessionId, {
    role: "assistant",
    content: "SQLite keeps the complete durable transcript",
    timestamp: "2026-08-01T10:00:02.000Z",
  });

  assert.equal(fs.readFileSync(historyPath, "utf8"), before);
  assert.equal(getHistory(sessionId).length, 3);
  assert.deepEqual(
    getHistoryPage(sessionId, 2).entries.map((entry) => entry.content),
    ["We should stop deferring revenue", "SQLite keeps the complete durable transcript"],
  );
  deleteSessionArtifacts(sessionId);
});

test("Remember searches stable entries and retrieves bounded surrounding context", async () => {
  const sessionId = "remember-tool-session";
  const entries = [
    appendHistory(sessionId, { role: "user", content: "Plan the marina accounting transition", timestamp: "2026-08-02T10:00:00.000Z" }),
    appendHistory(sessionId, { role: "assistant", content: "Use customer deposits before delivery", timestamp: "2026-08-02T10:00:01.000Z" }),
    appendHistory(sessionId, { role: "tool_call", toolName: "Bash", toolUseId: "tool-1", content: "npm test", toolInput: { command: "npm test" }, timestamp: "2026-08-02T10:00:02.000Z" }),
    appendHistory(sessionId, { role: "tool_result", toolUseId: "tool-1", content: "tests passed", toolOutput: "tests passed", timestamp: "2026-08-02T10:00:03.000Z" }),
    appendHistory(sessionId, { role: "run_boundary", content: "Run finished", runId: "run-1", runOutcome: "completed", runDurationMs: 3000, timestamp: "2026-08-02T10:00:04.000Z" }),
  ];

  const hits = rememberSearchHistory(sessionId, { query: "customer deposits" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionSeq, entries[1].sessionSeq);
  assert.match(hits[0].preview, /customer/i);

  const context = rememberHistoryContext(sessionId, entries[1].sessionSeq, 1, 1);
  assert.deepEqual(context.map((entry) => entry.role), ["user", "assistant", "tool_call"]);

  const packets = [];
  const ctx = {
    getSessionId: () => sessionId,
    send: (message) => packets.push(message),
    getTtsEngine: () => "system",
    getKokoroVoice: () => "",
    getKokoroSpeed: () => 1,
  };
  const searchResult = await handleRememberTool(ctx, {
    action: "search",
    query: "accounting transition",
  });
  assert.equal(searchResult.isError, undefined);
  const searchPayload = JSON.parse(searchResult.content[0].text);
  assert.equal(searchPayload.results[0].session_seq, entries[0].sessionSeq);

  const getResult = await handleRememberTool(ctx, {
    action: "get",
    session_seq: entries[1].sessionSeq,
  });
  assert.match(getResult.content[0].text, /customer deposits/);

  const listResult = await handleRememberTool(ctx, {
    action: "list",
    session_seq: entries[3].sessionSeq,
    direction: "before",
    limit: 2,
  });
  const listed = JSON.parse(listResult.content[0].text).entries;
  assert.deepEqual(listed.map((entry) => entry.session_seq), [entries[1].sessionSeq, entries[2].sessionSeq]);

  const runsResult = await handleRememberTool(ctx, { action: "runs", limit: 5 });
  const runs = JSON.parse(runsResult.content[0].text).runs;
  assert.equal(runs[0].outcome, "completed");
  assert.equal(runs[0].duration_ms, 3000);
  deleteSessionArtifacts(sessionId);
});
