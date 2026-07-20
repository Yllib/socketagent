const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");

const {
  appendHistory,
  deleteSessionArtifacts,
  getBoundedHistoryDelta,
  getBoundedHistoryTail,
  getHistory,
  positionSessionMessage,
} = require("../dist/session-store");

test("live revisions and persisted history share one transcript position", () => {
  const sessionId = `test-transcript-position-${randomUUID()}`;
  try {
    const firstFrame = positionSessionMessage(sessionId, {
      type: "text",
      sessionId,
      streamId: "assistant-stream-1",
      content: "hello",
    });
    const finalFrame = positionSessionMessage(sessionId, {
      type: "text",
      sessionId,
      streamId: "assistant-stream-1",
      content: "hello world",
      finalSnapshot: true,
    });
    const persistedText = appendHistory(sessionId, {
      role: "assistant",
      content: "hello world",
      streamId: "assistant-stream-1",
      timestamp: new Date().toISOString(),
    });

    assert.equal(finalFrame.entryId, firstFrame.entryId);
    assert.equal(finalFrame.sessionSeq, firstFrame.sessionSeq);
    assert.ok(finalFrame.revision > firstFrame.revision);
    assert.equal(persistedText.entryId, firstFrame.entryId);
    assert.equal(persistedText.sessionSeq, firstFrame.sessionSeq);
    assert.equal(persistedText.revision, finalFrame.revision);

    const liveTool = positionSessionMessage(sessionId, {
      type: "tool_call",
      sessionId,
      toolUseId: "tool-1",
      tool: "Bash",
      input: { command: "pwd" },
    });
    const persistedTool = appendHistory(sessionId, {
      role: "tool_call",
      content: "pwd",
      toolName: "Bash",
      toolUseId: "tool-1",
      toolInput: { command: "pwd" },
      timestamp: new Date().toISOString(),
    });

    assert.equal(persistedTool.entryId, liveTool.entryId);
    assert.equal(persistedTool.sessionSeq, liveTool.sessionSeq);
    assert.ok(liveTool.sessionSeq > firstFrame.sessionSeq);

    const history = getHistory(sessionId);
    assert.deepEqual(
      history.map((entry) => entry.sessionSeq),
      [firstFrame.sessionSeq, liveTool.sessionSeq],
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("bounded history resumes with only entries newer than the cached sequence", () => {
  const sessionId = `test-transcript-delta-${randomUUID()}`;
  try {
    const entries = [];
    for (let index = 0; index < 8; index++) {
      entries.push(appendHistory(sessionId, {
        role: index === 0 ? "user" : "assistant",
        content: `message-${index}`,
        timestamp: new Date(Date.now() + index).toISOString(),
      }));
    }

    const delta = getBoundedHistoryDelta(sessionId, entries[4].sessionSeq);
    assert.ok(delta);
    assert.deepEqual(
      delta.entries.map((entry) => entry.content),
      ["message-5", "message-6", "message-7"],
    );
    assert.equal(delta.offset, 5);
    assert.equal(delta.total, 8);

    const tail = getBoundedHistoryTail(sessionId, 3, 1024);
    assert.deepEqual(
      tail.entries.map((entry) => entry.content),
      ["message-5", "message-6", "message-7"],
    );
    assert.equal(tail.offset, 5);
    assert.equal(tail.total, 8);
    assert.equal(tail.deferredContextAvailable, true);
    assert.equal(tail.totalUserPrompts, 1);
    assert.equal(delta.totalUserPrompts, 1);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("oversized or incompatible deltas fail back to a bounded snapshot", () => {
  const sessionId = `test-transcript-delta-fallback-${randomUUID()}`;
  try {
    const first = appendHistory(sessionId, {
      role: "user",
      content: "start",
      timestamp: new Date().toISOString(),
    });
    for (let index = 0; index < 4; index++) {
      appendHistory(sessionId, {
        role: "assistant",
        content: `answer-${index}`,
        timestamp: new Date(Date.now() + index + 1).toISOString(),
      });
    }

    assert.equal(getBoundedHistoryDelta(sessionId, 999999), null);
    assert.equal(getBoundedHistoryDelta(sessionId, first.sessionSeq, 2), null);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("history keeps first-live order when streams finish out of order", () => {
  const sessionId = `test-transcript-concurrency-${randomUUID()}`;
  try {
    const earlier = positionSessionMessage(sessionId, {
      type: "text",
      sessionId,
      streamId: "earlier-stream",
      content: "started first",
    });
    const later = positionSessionMessage(sessionId, {
      type: "tool_call",
      sessionId,
      toolUseId: "later-tool",
      tool: "Bash",
      input: { command: "pwd" },
    });

    // The later card completes and is persisted before the earlier stream.
    appendHistory(sessionId, {
      role: "tool_call",
      content: "pwd",
      toolName: "Bash",
      toolUseId: "later-tool",
      toolInput: { command: "pwd" },
      timestamp: new Date().toISOString(),
    });
    appendHistory(sessionId, {
      role: "assistant",
      content: "started first and finished last",
      streamId: "earlier-stream",
      timestamp: new Date().toISOString(),
    });

    const history = getHistory(sessionId);
    assert.deepEqual(
      history.map((entry) => entry.sessionSeq),
      [earlier.sessionSeq, later.sessionSeq],
    );
    assert.deepEqual(
      history.map((entry) => entry.entryId),
      [earlier.entryId, later.entryId],
    );
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});

test("persisting another revision replaces the existing transcript row", () => {
  const sessionId = `test-transcript-upsert-${randomUUID()}`;
  try {
    const first = appendHistory(sessionId, {
      role: "secure_input",
      content: "Need token",
      questionId: "secure-test",
      status: "pending",
      answered: false,
      toolInput: { label: "Token", reason: "Need token", scope: "session" },
      timestamp: new Date().toISOString(),
    });
    const saved = appendHistory(sessionId, {
      role: "secure_input",
      content: "Need token",
      questionId: "secure-test",
      status: "saved",
      answered: true,
      toolInput: { label: "Token", reason: "Need token", scope: "session" },
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    const history = getHistory(sessionId);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "saved");
    assert.equal(saved.entryId, first.entryId);
    assert.equal(saved.sessionSeq, first.sessionSeq);
    assert.ok(saved.revision > first.revision);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});
