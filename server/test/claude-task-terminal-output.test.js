const assert = require("node:assert/strict");
const test = require("node:test");
require("./test-data-dir");

const { claudeTaskTerminalOutput } = require("#server/claude-session");

test("a finished agent shows its summary and never reads the transcript", () => {
  /** @type {string[]} */
  const read = [];
  /** @param {string} filePath */
  const readFile = (filePath) => {
    read.push(filePath);
    return '{"type":"assistant","message":{}}\n';
  };
  const transcript = "/home/u/.claude/projects/p/s/subagents/agent-a8d7bfd792fac7bea.jsonl";

  for (const args of [
    { taskType: "local_agent", isSubagent: false },
    { taskType: "remote_agent", isSubagent: false },
    { taskType: undefined, isSubagent: true },
    // Tracked by file name alone, for a notification the session never
    // registered (for example after a restart).
    { taskType: undefined, isSubagent: false },
  ]) {
    const result = claudeTaskTerminalOutput({
      status: "completed",
      summary: "I found 25 places where the name is plain text.",
      outputFile: transcript,
      readFile,
      ...args,
    });
    assert.equal(result.output, "I found 25 places where the name is plain text.");
    assert.equal(result.outputFile, undefined);
  }
  assert.deepEqual(read, []);

  const stopped = claudeTaskTerminalOutput({
    status: "stopped",
    summary: "",
    taskType: "local_agent",
    outputFile: transcript,
    isSubagent: true,
    readFile,
  });
  assert.equal(stopped.output, "Task stopped");
});

test("a finished bash task shows its output file, falling back to the summary", () => {
  const withOutput = claudeTaskTerminalOutput({
    status: "completed",
    summary: 'Background command "npm test" completed',
    taskType: "local_bash",
    outputFile: "/tmp/claude/tasks/b1.output",
    isSubagent: false,
    readFile: () => "797 tests passed\n",
  });
  assert.equal(withOutput.output, "797 tests passed\n");
  assert.equal(withOutput.outputFile, "/tmp/claude/tasks/b1.output");

  const unreadable = claudeTaskTerminalOutput({
    status: "failed",
    summary: 'Background command "npm test" failed',
    taskType: "local_bash",
    outputFile: "/tmp/claude/tasks/b2.output",
    isSubagent: false,
    readFile: () => { throw new Error("ENOENT"); },
  });
  assert.equal(unreadable.output, 'Background command "npm test" failed');
  assert.equal(unreadable.outputFile, "/tmp/claude/tasks/b2.output");
});
