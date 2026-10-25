const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash, randomUUID } = require("node:crypto");
require("./test-data-dir");

const {
  appendHistory,
  appendHistoryBulk,
  deleteSessionArtifacts,
  getActiveTaskStates,
  getResumeHistoryPage,
  settleStaleRuntimeTaskStates,
} = require("#server/session-store");

/**
 * The cursor a phone builds from the entries its cache holds.
 * @param {import("#server/protocol").HistoryEntry[]} entries
 */
function cursorFor(entries) {
  return {
    knownEntryRevisions: entries.map((entry) => [Number(entry.sessionSeq), Number(entry.revision)]),
    knownEntryIdentityDigest: createHash("sha256").update(entries.map((entry) =>
      `${entry.sessionSeq}:${entry.entryId}\n`).join("")).digest("hex"),
  };
}

/**
 * One turn as the server records it.
 * @param {string} sessionId
 * @param {number} index
 */
function turn(sessionId, index) {
  const at = (/** @type {number} */ step) => new Date(Date.now() + index * 10 + step).toISOString();
  const user = appendHistory(sessionId, { role: "user", content: `prompt-${index}`, timestamp: at(0) });
  const call = appendHistory(sessionId, {
    role: "tool_call", content: "", toolName: "Bash", toolUseId: `tool-${index}`, toolInput: { command: "ls" }, timestamp: at(1),
  });
  // Rows the phone never sees as live events, interleaved like the real server writes them.
  const task = appendHistory(sessionId, {
    role: "task_state", content: `background-${index}`, taskId: `task-${index}`, taskKind: "background",
    status: "running", isBackgrounded: true, timestamp: at(2),
  });
  const notice = appendHistory(sessionId, {
    role: "notification", content: "Attempting to resume interrupted work.", status: "info", timestamp: at(3),
  });
  const result = appendHistory(sessionId, {
    role: "tool_result", content: "", toolUseId: `tool-${index}`, toolOutput: "ok", timestamp: at(4),
  });
  const text = appendHistory(sessionId, { role: "assistant", content: `answer-${index}`, timestamp: at(5) });
  const boundary = appendHistory(sessionId, { role: "run_boundary", content: "Run finished", runId: `run-${index}`, timestamp: at(6) });
  const suggestion = appendHistory(sessionId, { role: "prompt_suggestion", content: "next?", timestamp: at(7) });
  return { live: [user, call, result, text], hidden: [task, notice, boundary, suggestion], task };
}

test("a cache with gaps for never-streamed rows still gets a delta, and the gaps are filled", () => {
  const sessionId = `test-resume-gaps-${randomUUID()}`;
  try {
    const first = turn(sessionId, 1);
    const second = turn(sessionId, 2);
    // The phone cached only what live events carried, from both turns.
    const cached = [...first.live, ...second.live];
    const page = getResumeHistoryPage(sessionId, {
      ...cursorFor(cached),
      knownHistoryOffset: 0,
      knownHistoryEntryCount: cached.length,
    });
    assert.equal(page.historyKind, "delta", page.fallbackReason);
    // Everything stored that the phone did not list comes back, in order.
    const stored = getResumeHistoryPage(sessionId).entries;
    const cachedSeqs = new Set(cached.map((entry) => entry.sessionSeq));
    const gaps = stored.filter((entry) => !cachedSeqs.has(entry.sessionSeq));
    assert.ok(gaps.length >= 6);
    assert.deepEqual(
      page.entries.map((entry) => entry.sessionSeq),
      gaps.map((entry) => entry.sessionSeq),
    );
    assert.deepEqual(new Set(page.entries.map((entry) => entry.role)),
      new Set(["task_state", "notification", "run_boundary", "prompt_suggestion"]));
    // The page offset is where entries newer than the cache begin.
    const newestCached = cached[cached.length - 1].sessionSeq;
    assert.equal(page.offset, stored.findIndex((entry) => entry.sessionSeq > newestCached));
    assert.equal(page.total, stored.length);
    assert.equal(page.deferredContextAvailable, false);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("a complete, current cache gets only the newer entries", () => {
  const sessionId = `test-resume-newer-${randomUUID()}`;
  try {
    const first = turn(sessionId, 1);
    const cached = [...first.live, ...first.hidden].sort((a, b) => a.sessionSeq - b.sessionSeq);
    const second = turn(sessionId, 2);
    const page = getResumeHistoryPage(sessionId, cursorFor(cached));
    assert.equal(page.historyKind, "delta", page.fallbackReason);
    assert.deepEqual(
      page.entries.map((entry) => entry.sessionSeq),
      [...second.live, ...second.hidden].map((entry) => entry.sessionSeq).sort((a, b) => a - b),
    );
    assert.equal(page.offset, 8);
    assert.deepEqual(getResumeHistoryPage(sessionId, cursorFor([...cached, ...page.entries])).entries, []);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("an entry revised after it was cached is re-sent at its new revision", () => {
  const sessionId = `test-resume-revised-${randomUUID()}`;
  try {
    const first = turn(sessionId, 1);
    const cached = [...first.live, ...first.hidden].sort((a, b) => a.sessionSeq - b.sessionSeq);
    const finished = appendHistory(sessionId, { ...first.task, status: "completed", revision: 2 });
    assert.equal(finished.sessionSeq, first.task.sessionSeq);
    const page = getResumeHistoryPage(sessionId, cursorFor(cached));
    assert.equal(page.historyKind, "delta", page.fallbackReason);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].entryId, first.task.entryId);
    assert.equal(page.entries[0].revision, 2);
    assert.equal(page.entries[0].status, "completed");
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("a cache whose identities no longer match falls back to a fresh page", () => {
  const sessionId = `test-resume-identity-${randomUUID()}`;
  try {
    const first = turn(sessionId, 1);
    const cached = [...first.live, ...first.hidden].sort((a, b) => a.sessionSeq - b.sessionSeq);
    const forged = cached.map((entry) => ({ ...entry, entryId: `other-${entry.sessionSeq}` }));
    const page = getResumeHistoryPage(sessionId, cursorFor(forged));
    assert.equal(page.historyKind, "initial");
    assert.match(page.fallbackReason, /identities differ/);

    const phantom = getResumeHistoryPage(sessionId, {
      knownEntryRevisions: [[1, 1], [999, 1]],
    });
    assert.equal(phantom.historyKind, "initial");
    assert.match(phantom.fallbackReason, /999 is not stored/);

    const malformed = getResumeHistoryPage(sessionId, { knownEntryRevisions: [[3, 1], [2, 1]] });
    assert.equal(malformed.historyKind, "initial");
    assert.match(malformed.fallbackReason, /malformed/);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("the legacy window cursor reports why a gappy cache gets a fresh page", () => {
  const sessionId = `test-resume-legacy-${randomUUID()}`;
  try {
    const first = turn(sessionId, 1);
    const page = getResumeHistoryPage(sessionId, {
      knownSessionSeq: first.live[3].sessionSeq,
      knownHistoryOffset: 0,
      knownHistoryEntryCount: first.live.length,
    });
    assert.equal(page.historyKind, "initial");
    assert.match(page.fallbackReason, /holds 4 of 6 entries/);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("only task states still in flight ride along with a resume", () => {
  const sessionId = `test-resume-task-states-${randomUUID()}`;
  try {
    const first = turn(sessionId, 1);
    const second = turn(sessionId, 2);
    appendHistory(sessionId, { ...first.task, status: "completed", revision: 2 });
    assert.deepEqual(
      getActiveTaskStates(sessionId).map((entry) => entry.taskId),
      [second.task.taskId],
    );
    // Settling only touches the in-flight rows left from an earlier server process.
    appendHistoryBulk(sessionId, [{ ...second.task, timestamp: "2020-01-01T00:00:00.000Z" }]);
    assert.equal(settleStaleRuntimeTaskStates(sessionId), 1);
    assert.deepEqual(getActiveTaskStates(sessionId), []);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("the app gets only the newest runs with its stats", () => {
  const { clientRunStats, CLIENT_RECENT_RUN_LIMIT } = require("#server/session-run-store");
  const runs = Array.from({ length: 500 }, (/** @type {unknown} */ _, index) => ({
    runId: `run-${index}`, runNumber: index + 1, startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000, outcome: "completed",
  }));
  const trimmed = clientRunStats({ completedCount: 500, totalDurationMs: 500_000, recentRuns: runs });
  assert.equal(trimmed?.recentRuns?.length, CLIENT_RECENT_RUN_LIMIT);
  assert.equal(trimmed?.recentRuns?.[0].runNumber, 451);
  assert.equal(trimmed?.completedCount, 500);
  const small = { completedCount: 2, totalDurationMs: 10, recentRuns: runs.slice(0, 2) };
  assert.equal(clientRunStats(small), small);
  assert.equal(clientRunStats(undefined), undefined);
});
