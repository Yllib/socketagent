const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
require("./test-data-dir");
const {
  getComputerIssues,
  onBackendHealthChange,
  recordCodexConfigWarning,
} = require("#server/server-settings");

test("a Codex config warning stays in the computer's issues until its file changes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, "obsolete = true\n");
  let changes = 0;
  const unsubscribe = onBackendHealthChange(() => changes++);
  t.after(() => {
    unsubscribe();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const message = "`obsolete` is ignored.";
  recordCodexConfigWarning(message, file);
  // Codex repeats it on every start; only the first one is news.
  recordCodexConfigWarning(message, file);
  assert.equal(changes, 1);
  assert.deepEqual(
    getComputerIssues().find((issue) => issue.message === message),
    { backend: "codex", severity: "warning", message, path: file },
  );

  fs.writeFileSync(file, "");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.ok(!getComputerIssues().some((issue) => issue.message === message));
});
