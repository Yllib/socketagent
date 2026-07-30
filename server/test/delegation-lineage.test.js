const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveDelegationSupervisorSessionId,
} = require("../dist/delegation-lineage");

function scheduledTask(overrides = {}) {
  return {
    id: "task-1",
    prompt: "Continue delegated work",
    cwd: process.cwd(),
    scheduledTime: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    status: "completed",
    runs: [],
    ...overrides,
  };
}

test("ordinary sessions authorize only their own delegation namespace", () => {
  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "current-session",
      scheduledTasks: [],
    }),
    "current-session",
  );
});

test("runtime and persisted lineage survive provider session rekeys", () => {
  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "new-provider-session",
      runtimeSupervisorSessionId: "original-supervisor",
      sessionInfo: {
        id: "new-provider-session",
        delegationSupervisorSessionId: "older-persisted-value",
      },
    }),
    "original-supervisor",
  );
  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "restored-session",
      sessionInfo: {
        id: "restored-session",
        delegationSupervisorSessionId: "original-supervisor",
      },
    }),
    "original-supervisor",
  );
});

test("legacy scheduled runs recover their original supervisor lineage", () => {
  const task = scheduledTask({
    createdBySessionId: "original-supervisor",
    sessionId: "latest-scheduled-run",
    runs: [
      {
        sessionId: "older-scheduled-run",
        startedAt: "2026-07-30T01:00:00.000Z",
        completedAt: "2026-07-30T01:01:00.000Z",
        status: "completed",
      },
    ],
  });

  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "latest-scheduled-run",
      scheduledTasks: [task],
    }),
    "original-supervisor",
  );
  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "older-scheduled-run",
      scheduledTasks: [task],
    }),
    "original-supervisor",
  );
});

test("legacy lineage fails closed when provenance is absent or ambiguous", () => {
  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "unrelated-session",
      scheduledTasks: [
        scheduledTask({
          createdBySessionId: "other-supervisor",
          sessionId: "different-run",
        }),
      ],
    }),
    "unrelated-session",
  );

  assert.equal(
    resolveDelegationSupervisorSessionId({
      currentSessionId: "ambiguous-run",
      scheduledTasks: [
        scheduledTask({
          id: "task-a",
          createdBySessionId: "supervisor-a",
          sessionId: "ambiguous-run",
        }),
        scheduledTask({
          id: "task-b",
          createdBySessionId: "supervisor-b",
          sessionId: "ambiguous-run",
        }),
      ],
    }),
    "ambiguous-run",
  );
});
