const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DELEGATED_AGENT_RESULT_TOOL,
  delegatedAgentResultHistoryEntries,
  delegatedAgentResultToolUseId,
} = require("../dist/delegated-agent-result-card");

function record() {
  return {
    delegationId: "delegation-1",
    parentSessionId: "parent-1",
    supervisorSessionId: "supervisor-1",
    childSessionId: "child-1",
    backend: "codex",
    cwd: "/workspace",
    label: "Audit the parser",
    status: "completed",
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:01:00.000Z",
    runs: [],
  };
}

test("builds one stable durable card pair for a delegated response", () => {
  const delegation = record();
  const run = {
    runId: "run-1",
    runNumber: 1,
    promptPreview: "Inspect session events",
    startedAt: "2026-08-04T12:00:00.000Z",
    completedAt: "2026-08-04T12:01:00.000Z",
    status: "completed",
    result: "The parser is fixed.",
  };

  const toolUseId = delegatedAgentResultToolUseId(delegation, run);
  const entries = delegatedAgentResultHistoryEntries(delegation, run);

  assert.equal(toolUseId, "delegated-agent-result:delegation-1:run-1");
  assert.equal(entries.call.toolName, DELEGATED_AGENT_RESULT_TOOL);
  assert.equal(entries.call.toolUseId, toolUseId);
  assert.equal(entries.call.toolInput._delegated_response, true);
  assert.equal(entries.call.toolInput.child_session_id, "child-1");
  assert.equal(entries.result.toolUseId, toolUseId);
  assert.equal(entries.result.toolOutput, "The parser is fixed.");
  assert.equal(entries.call.entryId, `${toolUseId}:call`);
  assert.equal(entries.result.entryId, `${toolUseId}:result`);
});

test("renders delegated failures as a terminal response card", () => {
  const delegation = record();
  const entries = delegatedAgentResultHistoryEntries(delegation, {
    runId: "run-2",
    runNumber: 2,
    promptPreview: "Retry the audit",
    startedAt: "2026-08-04T12:02:00.000Z",
    completedAt: "2026-08-04T12:03:00.000Z",
    status: "failed",
    error: "Child process exited",
  });

  assert.equal(entries.call.toolInput._task_status, "failed");
  assert.equal(entries.result.toolOutput, "Child process exited");
});
