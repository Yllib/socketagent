const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CodexSession } = require("../dist/codex-session");
const { ClaudeSession } = require("../dist/claude-session");

function testSocket(sent) {
  return {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

test("keeps Codex subagent threads attached to the root session", () => {
  const sent = [];
  const rootId = `test-root-${crypto.randomUUID()}`;
  const childId = `test-child-${crypto.randomUUID()}`;
  const grandchildId = `test-grandchild-${crypto.randomUUID()}`;
  const childToolUseId = `codex-subagent:${childId}`;
  const grandchildToolUseId = `codex-subagent:${grandchildId}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);

  // Seed the already-adopted root thread, then simulate notifications from a
  // concurrently running child thread.
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("thread/started", {
      thread: { id: childId },
      agentPath: "/root/reviewer",
    });

    assert.equal(session.getSessionId(), rootId);
    assert.ok(sent.some((message) =>
      message.type === "tool_call"
      && message.toolUseId === childToolUseId
      && message.sessionId === rootId));

    session.handleAppServerNotification("item/agentMessage/delta", {
      threadId: childId,
      itemId: "child-message-1",
      delta: "child output",
    });

    const childText = sent.find((message) =>
      message.type === "text" && message.content === "child output");
    assert.equal(childText.parentToolUseId, childToolUseId);
    assert.equal(childText.streamId, "child-message-1");

    session.handleAppServerNotification("item/completed", {
      threadId: childId,
      item: {
        id: "spawn-grandchild",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: [grandchildId],
        prompt: "Inspect nested behavior",
      },
    });

    const grandchildCall = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === grandchildToolUseId);
    assert.equal(grandchildCall.parentToolUseId, childToolUseId);
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("replays concurrent Claude streams with their original parents", () => {
  const sent = [];
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "claude-root";

  session._appendLiveStream(
    session._streamingText,
    { parent_tool_use_id: null, uuid: "main-message" },
    "main output",
  );
  session._appendLiveStream(
    session._streamingText,
    { parent_tool_use_id: "agent-tool-1", uuid: "child-message" },
    "child output",
  );
  session._appendLiveStream(
    session._streamingThinking,
    { parent_tool_use_id: "agent-tool-2", uuid: "thinking-message" },
    "child thinking",
  );

  session.replayLiveState();

  const mainText = sent.find((message) =>
    message.type === "text" && message.content === "main output");
  const childText = sent.find((message) =>
    message.type === "text" && message.content === "child output");
  const childThinking = sent.find((message) =>
    message.type === "thinking" && message.content === "child thinking");

  assert.equal(mainText.parentToolUseId, undefined);
  assert.equal(childText.parentToolUseId, "agent-tool-1");
  assert.equal(childText.uuid, "child-message");
  assert.equal(childThinking.parentToolUseId, "agent-tool-2");
  assert.equal(childThinking.uuid, "thinking-message");
});

test("replays the active Claude tool card for a late-joining client", () => {
  const sent = [];
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);
  session.sessionId = "claude-tool-root";
  session._activeToolUseId = "claude-tool-1";
  session._activeToolName = "Bash";

  session.replayLiveState();

  assert.ok(sent.some((message) =>
    message.type === "tool_call"
    && message.toolUseId === "claude-tool-1"
    && message.tool === "Bash"
    && message.replay === true));
});

test("replays an active Codex tool call after reconnect and retires it on completion", () => {
  const sent = [];
  const replayed = [];
  const rootId = `test-tool-replay-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "npm test",
      },
    });

    assert.deepEqual(session.getActiveToolCall(), {
      toolUseId: "command-1",
      name: "Bash",
    });

    session.replayLiveState(testSocket(replayed));
    assert.ok(replayed.some((message) =>
      message.type === "tool_call"
      && message.toolUseId === "command-1"
      && message.tool === "Bash"
      && message.sessionId === rootId));

    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "npm test",
        aggregatedOutput: "passed",
        exitCode: 0,
      },
    });

    assert.equal(session.getActiveToolCall(), null);
    replayed.length = 0;
    session.replayLiveState(testSocket(replayed));
    assert.equal(
      replayed.some((message) => message.toolUseId === "command-1"),
      false,
    );
  } finally {
    fs.rmSync(
      path.join(os.homedir(), ".claude-assistant", "history", `${rootId}.json`),
      { force: true },
    );
  }
});

test("late-joining Codex clients receive the complete cached prefix before new deltas", () => {
  const initial = [];
  const replayed = [];
  const rootId = `test-text-replay-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(initial), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "first half, ",
  });
  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "second half",
  });

  session.replayLiveState(testSocket(replayed));

  const snapshot = replayed.find((message) =>
    message.type === "text" && message.streamId === "message-1");
  assert.equal(snapshot.content, "first half, second half");
  assert.equal(snapshot.replay, true);
  assert.equal(snapshot.sessionId, rootId);
});
