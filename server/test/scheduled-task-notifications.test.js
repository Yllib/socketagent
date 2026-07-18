const assert = require("node:assert/strict");
const test = require("node:test");

const {
  scheduledTaskDisplayName,
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
