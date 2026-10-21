const assert = require("node:assert/strict");
const test = require("node:test");

const { toolApprovalMarkdown } = require("#server/tool-approval");

test("a Bash approval leads with the description and shows the command as code", () => {
  const text = toolApprovalMarkdown("Bash", { command: "rm -f \"$log/x\"", description: "Clear the log" }, "Dangerous rm");
  assert.equal(text, "**Bash: Clear the log**\n\nDangerous rm\n\n```bash\nrm -f \"$log/x\"\n```");
});

test("a command holding a fence gets a longer one", () => {
  const text = toolApprovalMarkdown("Bash", { command: "printf '```'" });
  assert.match(text, /^\*\*Allow Bash\?\*\*\n\n````bash\nprintf '```'\n````$/);
});

test("other tools show their input as JSON", () => {
  const text = toolApprovalMarkdown("Write", { file_path: "/tmp/a", content: "hi" });
  assert.equal(text, "**Allow Write?**\n\n```json\n{\n  \"file_path\": \"/tmp/a\",\n  \"content\": \"hi\"\n}\n```");
});
