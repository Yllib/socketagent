const assert = require("node:assert/strict");
const test = require("node:test");

const { parseClaudeBackgroundedBash } = require("../dist/claude-session");

const PATH = "/tmp/claude-1000/-home-billy/1a5b0279/tasks/b93c9j18e.output";

// The four wordings the harness builds, verbatim in shape.
const WORDINGS = {
  run_in_background:
    `Command running in background with ID: b93c9j18e. Output is being written to: ${PATH}.`
    + " You will be notified when it completes. To check interim output, use Read on that file path.",
  manual:
    `Command was manually backgrounded by user with ID: b93c9j18e. Output is being written to: ${PATH}.`,
  message_delivery:
    "Command was moved to the background (ID: b93c9j18e) so that a message that arrived while it"
    + ` was running can reach you; it was not interrupted. Output is being written to: ${PATH}.`
    + " You will be notified when it completes. To check interim output, use Read on that file path.",
  timed_out:
    "Command did not complete within its 120s timeout and was moved to the background"
    + ` (ID: b93c9j18e). Output is being written to: ${PATH}.`
    + " You will be notified when it completes. To check interim output, use Read on that file path.",
};

for (const [name, output] of Object.entries(WORDINGS)) {
  test(`recognises a command backgrounded by ${name}`, () => {
    assert.deepEqual(parseClaudeBackgroundedBash(output), {
      taskId: "b93c9j18e",
      outputFile: PATH,
    });
  });
}

test("the path never keeps the sentence's period", () => {
  for (const output of Object.values(WORDINGS)) {
    const parsed = parseClaudeBackgroundedBash(output);
    // A trailing period makes every watcher tail a file that does not exist.
    assert.ok(!parsed.outputFile.endsWith("."), `kept the period: ${parsed.outputFile}`);
    assert.ok(parsed.outputFile.endsWith(".output"));
  }
});

test("ordinary command output is not mistaken for a backgrounding notice", () => {
  assert.equal(parseClaudeBackgroundedBash(""), null);
  assert.equal(parseClaudeBackgroundedBash("ID: 12345\nall tests passed"), null);
  assert.equal(
    parseClaudeBackgroundedBash("running 4 jobs in background mode\ndone"),
    null,
  );
});

// ── Stripping the notice out of what the app shows ──

const { stripClaudeBackgroundedBashNotice } = require("../dist/claude-session");

// Verbatim from a real ebookillustrator run, trailer included.
const REAL_NOTICE =
  "Command running in background with ID: b6pwyrh6f. Output is being written to:"
  + " /tmp/claude-1000/-home-billy-agents-ebookillustrator/064cb7b0-0696-43d9-8726-01f4866a8eea/tasks/b6pwyrh6f.output."
  + " You will be notified when it completes. To check interim output, use Read on that file path."
  + "\nSession cwd remains /home/billy/agents/ebookillustrator; directory changes made by the"
  + " backgrounded command do not apply to subsequent commands.";

test("a backgrounded result carries nothing to show", () => {
  assert.equal(stripClaudeBackgroundedBashNotice(REAL_NOTICE), "");
});

for (const [name, notice] of Object.entries(WORDINGS)) {
  test(`the ${name} notice is removed`, () => {
    assert.equal(stripClaudeBackgroundedBashNotice(notice), "");
  });
}

test("output printed before the command was backgrounded survives", () => {
  const withOutput = `chapter 3 rendered\nchapter 4 rendered\n${REAL_NOTICE}`;
  assert.equal(
    stripClaudeBackgroundedBashNotice(withOutput),
    "chapter 3 rendered\nchapter 4 rendered",
  );
});

test("an ordinary tool result is left alone", () => {
  const ordinary = "total 12\n-rw-rw-r-- 1 billy billy 10 b332rvi6y.output";
  assert.equal(stripClaudeBackgroundedBashNotice(ordinary), ordinary);
});
