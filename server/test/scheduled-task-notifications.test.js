const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  scheduledTaskDisplayName,
  scheduledTaskRevisionForPath,
  scheduledTaskUsesAutomaticNotifications,
} = require("../dist/scheduled-task-store");

test("scheduled task labels are preferred over prompt text", () => {
  assert.equal(
    scheduledTaskDisplayName({
      name: "  Nightly   backup check  ",
      prompt: "Inspect every backup and report any failures.",
    }),
    "Nightly backup check",
  );
});

test("legacy scheduled tasks derive a bounded label from the first prompt line", () => {
  assert.equal(
    scheduledTaskDisplayName({
      prompt: "Check the NAS health\nThen inspect the backup logs.",
    }),
    "Check the NAS health",
  );
});

test("quiet scheduled tasks disable every automatic notification path", () => {
  assert.equal(
    scheduledTaskUsesAutomaticNotifications({ notificationMode: "quiet" }),
    false,
  );
  assert.equal(
    scheduledTaskUsesAutomaticNotifications({ notificationMode: "completion" }),
    true,
  );
  assert.equal(
    scheduledTaskUsesAutomaticNotifications({}),
    true,
  );
});

test("scheduled task revisions change whenever the authoritative file changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-task-revision-"));
  const file = path.join(dir, "scheduled-tasks.json");
  try {
    assert.equal(scheduledTaskRevisionForPath(file), "missing");
    fs.writeFileSync(file, "[]");
    const emptyRevision = scheduledTaskRevisionForPath(file);
    fs.writeFileSync(file, '[{"id":"task-1"}]');
    assert.notEqual(scheduledTaskRevisionForPath(file), emptyRevision);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
