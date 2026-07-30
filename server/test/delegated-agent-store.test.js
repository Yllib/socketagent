const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-delegation-test-"));
process.env.SOCKETAGENT_DATA_DIR = dataDir;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const {
  addDelegatedAgentRun,
  getDelegatedAgent,
  listDelegatedAgents,
  pendingDelegatedAgentReports,
  saveDelegatedAgent,
  updateDelegatedAgentRun,
} = require("../dist/delegated-agent-store");
const {
  handleAgentSessionTool,
  handleScheduleTaskTool,
} = require("../dist/app-tool-handlers");
const { getScheduledTask } = require("../dist/scheduled-task-store");

function record(id = "delegation-1") {
  const now = new Date().toISOString();
  return {
    delegationId: id,
    supervisorSessionId: "supervisor-1",
    childSessionId: "child-1",
    backend: "codex",
    cwd: process.cwd(),
    label: "Review the implementation",
    status: "running",
    createdAt: now,
    updatedAt: now,
    runs: [],
  };
}

test("persists delegation lineage, runs, and pending completion reports", () => {
  saveDelegatedAgent(record());
  assert.equal(getDelegatedAgent("child-1").delegationId, "delegation-1");
  assert.equal(getDelegatedAgent("child-1", "another-supervisor"), undefined);

  addDelegatedAgentRun("delegation-1", {
    runId: "run-1",
    runNumber: 1,
    promptPreview: "Review it",
    startedAt: new Date().toISOString(),
    status: "running",
  });
  updateDelegatedAgentRun(
    "delegation-1",
    "run-1",
    {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: "Review complete",
      reportStatus: "pending",
    },
    "completed",
  );

  const pending = pendingDelegatedAgentReports();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].record.childSessionId, "child-1");
  assert.equal(pending[0].run.result, "Review complete");

  updateDelegatedAgentRun("delegation-1", "run-1", {
    reportStatus: "delivered",
    reportDeliveredAt: new Date().toISOString(),
  });
  assert.equal(pendingDelegatedAgentReports().length, 0);
  assert.equal(listDelegatedAgents("supervisor-1").length, 1);
});

test("AgentSession handler returns stable child IDs and follow-up guidance", async () => {
  const calls = [];
  const result = await handleAgentSessionTool(
    {
      getSessionId: () => "supervisor-1",
      getCwd: () => process.cwd(),
      getBackend: () => "claude",
      send: () => {},
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      manageAgentSession: async (args) => {
        calls.push(args);
        return {
          action: "start",
          delegation: record(),
          message: "Independent Codex agent started.",
        };
      },
    },
    {
      action: "start",
      backend: "codex",
      prompt: "Review it",
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"session_id": "child-1"/);
  assert.match(result.content[0].text, /action="message"/);
  assert.match(result.content[0].text, /while it is running/);
  assert.match(result.content[0].text, /next safe boundary/);
});

test("scheduled continuations retain the canonical delegation supervisor", async () => {
  let savedTaskId;
  const result = await handleScheduleTaskTool(
    {
      getSessionId: () => "fresh-scheduled-session",
      getDelegationSupervisorSessionId: () => "original-supervisor",
      getBackend: () => "claude",
      send: (message) => {
        savedTaskId = message.task.id;
      },
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
    },
    {
      name: "Continue child review",
      prompt: "Return to the delegated child and ask a follow-up.",
      cwd: process.cwd(),
      scheduledTime: new Date(Date.now() + 60_000).toISOString(),
    },
  );

  assert.equal(result.isError, undefined);
  assert.ok(savedTaskId);
  assert.equal(
    getScheduledTask(savedTaskId).createdBySessionId,
    "original-supervisor",
  );
});
