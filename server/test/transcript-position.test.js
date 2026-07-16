const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");

const {
  appendHistory,
  deleteSessionArtifacts,
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
