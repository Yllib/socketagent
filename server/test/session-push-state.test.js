const assert = require("node:assert/strict");
const test = require("node:test");

const {
  completionTranscriptTarget,
  SessionPushRunTracker,
  sessionPushEventId,
} = require("../dist/session-push-state");

test("one session run can claim its completion only once", () => {
  const tracker = new SessionPushRunTracker();
  const session = {};
  const startedAt = "2026-07-28T12:00:00.000Z";

  assert.ok(tracker.claimStarted(session, "session-1", startedAt));
  const completion = tracker.claimCompletion(
    session,
    "session-1",
    "2026-07-28T12:01:00.000Z",
  );
  assert.equal(completion.startedAt, startedAt);
  assert.equal(
    tracker.claimCompletion(
      session,
      "session-1",
      "2026-07-28T12:02:00.000Z",
    ),
    null,
  );
});

test("a later turn on the same session gets a distinct completion", () => {
  const tracker = new SessionPushRunTracker();
  const session = {};

  tracker.claimStarted(session, "session-1", "2026-07-28T12:00:00.000Z");
  assert.ok(
    tracker.claimCompletion(
      session,
      "session-1",
      "2026-07-28T12:01:00.000Z",
    ),
  );
  tracker.claimStarted(session, "session-1", "2026-07-28T13:00:00.000Z");
  assert.ok(
    tracker.claimCompletion(
      session,
      "session-1",
      "2026-07-28T13:01:00.000Z",
    ),
  );
});

test("completion event identity is stable for a run", () => {
  const startedAt = "2026-07-28T12:00:00.000Z";
  assert.equal(
    sessionPushEventId("session_finished", "session-1", startedAt),
    sessionPushEventId("session_finished", "session-1", startedAt),
  );
  assert.notEqual(
    sessionPushEventId("session_finished", "session-1", startedAt),
    sessionPushEventId(
      "session_finished",
      "session-1",
      "2026-07-28T13:00:00.000Z",
    ),
  );
});

test("completion notifications target the latest positioned assistant message", () => {
  assert.deepEqual(
    completionTranscriptTarget([
      { role: "assistant", entryId: "assistant-1", sessionSeq: 4 },
      { role: "user", entryId: "user-2", sessionSeq: 5 },
      { role: "assistant", entryId: "assistant-2", sessionSeq: 6 },
      { role: "tool_result", entryId: "tool-1", sessionSeq: 7 },
    ]),
    { targetEntryId: "assistant-2", targetSessionSeq: 6 },
  );
});

test("completion targeting tolerates legacy history without positioned rows", () => {
  assert.deepEqual(
    completionTranscriptTarget([
      { role: "assistant" },
      { role: "user", entryId: "user-1", sessionSeq: 1 },
    ]),
    {},
  );
});

test("completion targeting never points at an assistant message from an older run", () => {
  assert.deepEqual(
    completionTranscriptTarget(
      [
        {
          role: "assistant",
          entryId: "old-assistant",
          sessionSeq: 8,
          timestamp: "2026-07-28T11:59:00.000Z",
        },
      ],
      "2026-07-28T12:00:00.000Z",
    ),
    {},
  );
});
