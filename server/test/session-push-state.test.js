const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
