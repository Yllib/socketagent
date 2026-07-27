const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isClaudeWorkflowLaunchOutput,
  sanitizeClaudeWorkflowState,
  workflowStatePathForLaunch,
} = require("../dist/claude-session");

test("recognizes a Claude Workflow launch and derives its durable state file", () => {
  const launch = {
    status: "async_launched",
    taskType: "local_workflow",
    taskId: "task-1",
    runId: "wf_run-1",
    scriptPath: "/tmp/project/workflows/scripts/wf_run-1.mjs",
  };

  assert.equal(isClaudeWorkflowLaunchOutput(launch), true);
  assert.equal(
    workflowStatePathForLaunch(launch),
    "/tmp/project/workflows/wf_run-1.json",
  );
  assert.equal(
    isClaudeWorkflowLaunchOutput({ ...launch, taskType: "local_agent" }),
    false,
  );
});

test("sanitizes workflow phases, agents, metrics, and results for app history", () => {
  const state = sanitizeClaudeWorkflowState({
    status: "completed",
    workflowName: "Review and verify",
    summary: "Two-agent review",
    agentCount: 2,
    totalTokens: 1234,
    totalToolCalls: 8,
    durationMs: 2500,
    phases: [{ title: "Review", detail: "Independent passes" }],
    workflowProgress: [{
      type: "workflow_agent",
      phaseIndex: 0,
      label: "Reviewer",
      agentId: "agent-1",
      model: "opus",
      state: "completed",
      tokens: 617,
      toolCalls: 4,
      durationMs: 1200,
      promptPreview: "Review the implementation.",
      resultPreview: "No blocking issue.",
    }],
    logs: ["phase started", "phase completed"],
    result: { verdict: "pass" },
    script: "must not cross the wire",
  }, {
    taskId: "task-1",
    toolUseId: "tool-1",
  });

  assert.equal(state.status, "completed");
  assert.equal(state.phases[0].title, "Review");
  assert.equal(state.progress[0].agentId, "agent-1");
  assert.equal(state.totalTokens, 1234);
  assert.match(state.resultPreview, /"verdict": "pass"/);
  assert.equal(Object.hasOwn(state, "script"), false);
});
