const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findUntrackedDelegatedRestartContinuation,
} = require("../dist/delegated-agent-restart-recovery");

function record(overrides = {}) {
  return {
    delegationId: "delegation-1",
    supervisorSessionId: "supervisor-1",
    childSessionId: "child-1",
    backend: "codex",
    cwd: "/tmp",
    label: "Review work",
    status: "completed",
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:02:00.000Z",
    runs: [{
      runId: "run-1",
      runNumber: 1,
      promptPreview: "Review work",
      startedAt: "2026-08-04T10:00:00.000Z",
      completedAt: "2026-08-04T10:02:00.000Z",
      status: "completed",
      result: "[Server restart complete.]",
      reportStatus: "delivered",
    }],
    ...overrides,
  };
}

test("recovers the real child completion after a detached restart continuation", () => {
  const recovery = findUntrackedDelegatedRestartContinuation(record(), [
    { role: "assistant", content: "[Server restart complete.]", timestamp: "2026-08-04T10:02:00.000Z" },
    { role: "user", content: "[System: The server restart completed successfully (3s). Continue where you left off.]", timestamp: "2026-08-04T10:02:03.000Z" },
    { role: "assistant", content: "Still working", timestamp: "2026-08-04T10:03:00.000Z" },
    { role: "assistant", content: "The durable child result", timestamp: "2026-08-04T10:05:00.000Z" },
    { role: "run_boundary", content: "Run finished", timestamp: "2026-08-04T10:05:01.000Z" },
  ]);

  assert.deepEqual(recovery, {
    startedAt: "2026-08-04T10:02:03.000Z",
    status: "completed",
    completedAt: "2026-08-04T10:05:01.000Z",
    result: "The durable child result",
  });
});
test("reattaches an in-progress restart continuation to the delegation", () => {
  const recovery = findUntrackedDelegatedRestartContinuation(record(), [
    { role: "user", content: "[System: The server restart completed successfully (4s). Continue where you left off.]", timestamp: "2026-08-04T10:02:03.000Z" },
    { role: "assistant", content: "Still working", timestamp: "2026-08-04T10:03:00.000Z" },
  ]);

  assert.deepEqual(recovery, {
    startedAt: "2026-08-04T10:02:03.000Z",
    status: "running",
  });
});

test("does not duplicate a tracked or stopped continuation", () => {
  const history = [{
    role: "user",
    content: "[System: The server restart completed successfully (4s). Continue where you left off.]",
    timestamp: "2026-08-04T10:02:03.000Z",
  }];
  assert.equal(findUntrackedDelegatedRestartContinuation(record({
    status: "running",
    runs: [...record().runs, {
      runId: "run-2",
      runNumber: 2,
      promptPreview: "Restart continuation",
      startedAt: "2026-08-04T10:02:03.000Z",
      status: "running",
    }],
  }), history), undefined);
  assert.equal(findUntrackedDelegatedRestartContinuation(record({ status: "stopped" }), history), undefined);
});
