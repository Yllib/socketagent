const assert = require("node:assert/strict");
const test = require("node:test");

const { promptTitle } = require("#server/prompt-title");

test("scheduled-task context blocks never become the session title", () => {
  const prompt = [
    "<socketagent_scheduled_task>",
    "This scheduled task is running in quiet mode.",
    "</socketagent_scheduled_task>",
    "",
    "<socketagent_prior_runs>",
    "Prior run 1 of 1",
    "</socketagent_prior_runs>",
    "",
    "Check the Play review status",
    "Then report back.",
  ].join("\n");
  assert.equal(promptTitle(prompt), "Check the Play review status");
});

test("long first lines are cut, and a prompt that is only context has no title", () => {
  assert.equal(promptTitle("a".repeat(60)), `${"a".repeat(50)}...`);
  assert.equal(
    promptTitle("<socketagent_scheduled_task>\nQuiet mode.\n</socketagent_scheduled_task>"),
    "",
  );
});
