const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
require("./test-data-dir");
const {
  currentCodexConfigWarnings,
  onBackendHealthChange,
  recordCodexConfigWarning,
} = require("#server/server-settings");

test("a Codex config warning stays on the computer until its file changes", (t) => {
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
  assert.ok(currentCodexConfigWarnings().includes(message));

  fs.writeFileSync(file, "");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.ok(!currentCodexConfigWarnings().includes(message));
});
