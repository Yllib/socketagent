const assert = require("node:assert/strict");
const test = require("node:test");

const {
  deriveHistoricalRuns,
  extractEngineIntervals,
} = require("../dist/session-run-backfill");

const iso = (seconds) => new Date(Date.UTC(2026, 7, 4, 10, 0, seconds)).toISOString();
const user = (seconds, content = "Do the work") => ({
  role: "user",
  content,
  timestamp: iso(seconds),
});
const assistant = (seconds, content = "Done") => ({
  role: "assistant",
  content,
  timestamp: iso(seconds),
});
const claudeResult = (endSeconds, durationMs) => ({
  sdkType: "result",
  ts: iso(endSeconds),
  durationMs,
});
const codexStarted = (id, seconds) => ({
  method: "turn/started",
  ts: iso(seconds),
  params: { turn: { id } },
});
const codexCompleted = (id, seconds, durationMs) => ({
  method: "turn/completed",
  ts: iso(seconds),
  params: { turn: { id, durationMs } },
});

test("extracts exact Claude and Codex lifecycle intervals", () => {
  const intervals = extractEngineIntervals([
    claudeResult(20, 20_000),
    codexStarted("turn-1", 30),
    codexCompleted("turn-1", 50, 20_000),
    // A completed event remains sufficient when the started frame was absent.
    codexCompleted("turn-2", 70, 10_000),
  ]);
  assert.deepEqual(intervals.map((interval) => [interval.startMs, interval.endMs]), [
    [Date.parse(iso(0)), Date.parse(iso(20))],
    [Date.parse(iso(30)), Date.parse(iso(50))],
    [Date.parse(iso(60)), Date.parse(iso(70))],
  ]);
});

test("matches idle prompts while keeping mid-run injected messages in one run", () => {
  const runs = deriveHistoricalRuns([
    user(0),
    user(10, "Additional context while you work"),
    assistant(30),
    user(60, "Next run"),
    assistant(80),
  ], [
    claudeResult(30, 30_000),
    claudeResult(80, 20_000),
  ]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.durationMs), [30_000, 20_000]);
  assert.ok(runs.every((run) => run.source === "sdk_backfill"));
});

test("merges immediate automatic continuations into one Codex logical run", () => {
  const runs = deriveHistoricalRuns([
    user(0),
    assistant(40),
  ], [
    codexCompleted("turn-1", 20, 20_000),
    codexCompleted("turn-2", 40, 18_000),
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].durationMs, 40_000);
});

test("delegated work and the resumed supervisor remain one wall-clock run", () => {
  const delegations = [{
    delegationId: "delegation-1",
    supervisorSessionId: "parent",
    backend: "codex",
    cwd: "/tmp",
    label: "child",
    status: "completed",
    createdAt: iso(10),
    updatedAt: iso(70),
    runs: [{
      runId: "child-run",
      runNumber: 1,
      promptPreview: "child work",
      startedAt: iso(10),
      completedAt: iso(55),
      reportDeliveredAt: iso(60),
      reportStatus: "delivered",
      status: "completed",
    }],
  }];
  const runs = deriveHistoricalRuns([
    user(0),
    // This is an injection during the delegation wait, not a new idle run.
    user(45, "One more detail"),
    user(60, "<socketagent_delegation_report>child done"),
    assistant(70),
    user(100, "Actually start another run"),
    assistant(110),
  ], [
    codexCompleted("parent-initial", 20, 20_000),
    codexCompleted("parent-resumed", 70, 10_000),
    codexCompleted("next", 110, 10_000),
  ], delegations);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.durationMs), [70_000, 10_000]);
});

test("uses transcript estimates only for history older than lifecycle capture", () => {
  const runs = deriveHistoricalRuns([
    user(0),
    assistant(15),
    user(40),
    assistant(50),
    user(100),
    assistant(120),
  ], [claudeResult(120, 20_000)]);
  assert.deepEqual(runs.map((run) => [run.durationMs, run.source]), [
    [15_000, "transcript_estimate"],
    [10_000, "transcript_estimate"],
    [20_000, "sdk_backfill"],
  ]);
});

test("filters system continuations from transcript-only run counts", () => {
  const runs = deriveHistoricalRuns([
    user(0),
    assistant(10),
    user(20, "[System: The server restart completed successfully.]"),
    assistant(30),
    user(40, "Real next prompt"),
    assistant(50),
  ], []);
  assert.deepEqual(runs.map((run) => run.durationMs), [30_000, 10_000]);
});
