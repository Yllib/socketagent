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

test("raw Codex SDK events are sent only to subscribed sockets", () => {
  const sent = [];
  const socket = testSocket(sent);
  const session = new CodexSession(socket, process.cwd(), []);
  session.sessionId = "raw-subscription-test";
  session.threadId = "raw-subscription-test";

  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: session.threadId,
    itemId: "message-1",
    delta: "first",
  });
  assert.equal(sent.some((message) => message.type === "sdk_event"), false);

  socket.supportsRawSdkEvents = true;
  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: session.threadId,
    itemId: "message-1",
    delta: " second",
  });
  assert.equal(sent.some((message) =>
    message.type === "sdk_event"
    && message.method === "item/agentMessage/delta"), true);
});

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

test("uses the stable Claude API message id across partial stream event UUIDs", () => {
  const session = new ClaudeSession(testSocket([]), process.cwd(), []);

  const started = session._streamKey({
    type: "stream_event",
    uuid: "event-frame-1",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: "api-message-1" } },
  });
  const firstDelta = session._streamKey({
    type: "stream_event",
    uuid: "event-frame-2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0 },
  });
  const secondDelta = session._streamKey({
    type: "stream_event",
    uuid: "event-frame-3",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0 },
  });
  const completed = session._streamKey({
    type: "assistant",
    uuid: "assistant-transcript-uuid",
    parent_tool_use_id: null,
    message: { id: "api-message-1" },
  });

  assert.equal(started, "main:api-message-1");
  assert.equal(firstDelta, started);
  assert.equal(secondDelta, started);
  assert.equal(completed, started);
});

test("keeps interleaved Claude subagent message streams in separate lanes", () => {
  const session = new ClaudeSession(testSocket([]), process.cwd(), []);

  session._streamKey({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: "main-api-message" } },
  });
  session._streamKey({
    type: "stream_event",
    parent_tool_use_id: "agent-tool-1",
    event: { type: "message_start", message: { id: "child-api-message" } },
  });

  assert.equal(
    session._streamKey({
      type: "stream_event",
      uuid: "new-main-frame",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0 },
    }),
    "main:main-api-message",
  );
  assert.equal(
    session._streamKey({
      type: "stream_event",
      uuid: "new-child-frame",
      parent_tool_use_id: "agent-tool-1",
      event: { type: "content_block_delta", index: 0 },
    }),
    "agent-tool-1:child-api-message",
  );
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

test("renders dynamic exec results as readable output instead of content-item JSON", () => {
  const sent = [];
  const rootId = `test-dynamic-exec-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  try {
    session.handleAppServerNotification("item/started", {
      threadId: rootId,
      item: {
        id: "dynamic-exec-1",
        type: "dynamicToolCall",
        tool: "exec",
        arguments: { task: "inspect changes" },
      },
    });
    session.handleAppServerNotification("item/completed", {
      threadId: rootId,
      item: {
        id: "dynamic-exec-1",
        type: "dynamicToolCall",
        tool: "exec",
        success: true,
        contentItems: [
          {
            type: "input_text",
            text: "Script completed\nWall time 0.4 seconds\nOutput:\n",
          },
          {
            type: "input_text",
            text: JSON.stringify({
              chunk_id: "77b278",
              wall_time_seconds: 0.4,
              exit_code: 0,
              output: "15 files changed, 291 insertions(+), 75 deletions(-)",
            }),
          },
        ],
      },
    });

    const call = sent.find((message) =>
      message.type === "tool_call" && message.toolUseId === "dynamic-exec-1");
    const result = sent.find((message) =>
      message.type === "tool_result" && message.toolUseId === "dynamic-exec-1");
    assert.equal(call.tool, "Exec");
    assert.equal(
      result.output,
      "Script completed\nWall time 0.4 seconds\nOutput:\n15 files changed, 291 insertions(+), 75 deletions(-)",
    );
    assert.equal(result.output.includes('"type": "input_text"'), false);
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

test("Codex live text frames are cumulative snapshots with a durable final frame", () => {
  const sent = [];
  const rootId = `test-text-snapshot-${crypto.randomUUID()}`;
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = rootId;
  session.threadId = rootId;

  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "first ",
  });
  session.handleAppServerNotification("item/agentMessage/delta", {
    threadId: rootId,
    itemId: "message-1",
    delta: "second",
  });
  session.handleAppServerNotification("item/completed", {
    threadId: rootId,
    item: {
      type: "agentMessage",
      id: "message-1",
      text: "first second",
    },
  });

  const frames = sent.filter((message) => message.type === "text");
  assert.deepEqual(frames.map((message) => message.content), [
    "first ",
    "first second",
  ]);
  assert.ok(frames.every((message) => message.streamId === "message-1"));
  assert.ok(frames.every((message) => message.snapshot === true));
  assert.equal(frames.at(-1).finalSnapshot, true);
});
