// Schedule rules: input validation, next-run times and the status a task
// settles in after a run. Calendar steps are checked in a zone with daylight
// saving, so TZ is set before anything reads the clock.
process.env.TZ = "America/New_York";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSchedule, getNextRunTime, settleScheduledTaskAfterRun, scheduledTaskCanArchive, MIN_CUSTOM_INTERVAL_MS } = require("#server/scheduled-task-store");

/** @param {string} iso */
const at = (iso) => new Date(iso).getTime();

test("parseSchedule rejects unusable times and intervals", () => {
  assert.ok("error" in parseSchedule("not a date", null));
  assert.ok("error" in parseSchedule("", null));
  for (const intervalMs of [undefined, 0, -3_600_000, MIN_CUSTOM_INTERVAL_MS - 1, 90_000.5]) {
    assert.ok("error" in parseSchedule("2026-11-01T12:00:00Z", { type: "custom", intervalMs }), String(intervalMs));
  }
  assert.ok("error" in parseSchedule("2026-11-01T12:00:00Z", { type: "weekly", daysOfWeek: [7] }));
  assert.ok("error" in parseSchedule("2026-11-01T12:00:00Z", { type: "hourly" }));
});

test("parseSchedule normalizes the time and keeps only the fields a type uses", () => {
  assert.deepEqual(parseSchedule("2026-11-01T08:00:00-05:00", { type: "once" }), { scheduledTime: "2026-11-01T13:00:00.000Z" });
  assert.deepEqual(parseSchedule("2026-11-01T12:00:00Z", { type: "daily", intervalMs: 5 }).recurrence, { type: "daily" });
  assert.deepEqual(parseSchedule("2026-11-01T12:00:00Z", { type: "custom", intervalMs: 3_600_000 }).recurrence, { type: "custom", intervalMs: 3_600_000 });
  assert.deepEqual(parseSchedule("2026-11-01T12:00:00Z", { type: "weekly", daysOfWeek: [5, 1, 5] }).recurrence, { type: "weekly", daysOfWeek: [1, 5] });
  assert.deepEqual(parseSchedule("2026-01-31T15:00:00Z", { type: "monthly" }).recurrence, { type: "monthly", dayOfMonth: 31 });
});

test("a bad stored interval ends the schedule instead of hanging", () => {
  for (const intervalMs of [-60_000, 0, 1]) {
    assert.equal(getNextRunTime({ scheduledTime: "2026-11-01T12:00:00Z", recurrence: { type: "custom", intervalMs } }, at("2026-11-02T00:00:00Z")), null);
  }
  assert.equal(getNextRunTime({ scheduledTime: "garbage", recurrence: { type: "daily" } }), null);
});

test("custom intervals land on the anchor's grid, strictly after now", () => {
  const task = { scheduledTime: "2026-11-01T12:00:00.000Z", recurrence: { type: "custom", intervalMs: 3_600_000 } };
  assert.equal(getNextRunTime(task, at("2026-11-01T11:00:00Z")), "2026-11-01T13:00:00.000Z");
  assert.equal(getNextRunTime(task, at("2026-11-01T14:00:00Z")), "2026-11-01T15:00:00.000Z");
  assert.equal(getNextRunTime(task, at("2026-11-01T14:30:00Z")), "2026-11-01T15:00:00.000Z");
});

test("daily and weekly keep the local clock time across daylight saving", () => {
  // 09:00 EDT on Saturday 31 Oct; clocks fall back on Sunday 1 Nov.
  const daily = { scheduledTime: "2026-10-31T13:00:00.000Z", recurrence: { type: "daily" } };
  assert.equal(getNextRunTime(daily, at("2026-10-31T13:00:00Z")), "2026-11-01T14:00:00.000Z");
  const weekly = { scheduledTime: "2026-10-31T13:00:00.000Z", recurrence: { type: "weekly" } };
  assert.equal(getNextRunTime(weekly, at("2026-10-31T13:00:00Z")), "2026-11-07T14:00:00.000Z");
  // An anchor months old skips ahead to the next 09:00 after now.
  assert.equal(getNextRunTime(daily, at("2027-03-20T15:00:00Z")), "2027-03-21T13:00:00.000Z");
});

test("weekly with weekdays runs on each chosen day", () => {
  // Monday 2 Nov 2026, 09:00 EST; runs Monday and Thursday.
  const task = { scheduledTime: "2026-11-02T14:00:00.000Z", recurrence: { type: "weekly", daysOfWeek: [1, 4] } };
  assert.equal(getNextRunTime(task, at("2026-11-02T14:00:00Z")), "2026-11-05T14:00:00.000Z");
  assert.equal(getNextRunTime({ ...task, scheduledTime: "2026-11-05T14:00:00.000Z" }, at("2026-11-05T14:00:00Z")), "2026-11-09T14:00:00.000Z");
});

test("monthly clamps to short months and returns to the anchor day", () => {
  const recurrence = { type: "monthly", dayOfMonth: 31 };
  // 10:00 EST on 31 Jan 2027.
  const feb = getNextRunTime({ scheduledTime: "2027-01-31T15:00:00.000Z", recurrence }, at("2027-01-31T15:00:00Z"));
  assert.equal(feb, "2027-02-28T15:00:00.000Z");
  assert.equal(getNextRunTime({ scheduledTime: feb, recurrence }, at(feb)), "2027-03-31T14:00:00.000Z");
});

test("settling a run", async (t) => {
  const base = () => ({ id: "t", prompt: "p", cwd: "/", createdAt: "x", status: "running", scheduledTime: "2026-11-01T12:00:00.000Z" });
  const now = at("2026-11-01T12:05:00Z");

  await t.test("a manual run leaves a cancelled or pending task as it was", () => {
    for (const resume of ["cancelled", "pending"]) {
      const task = { ...base(), recurrence: { type: "daily" } };
      settleScheduledTaskAfterRun(task, { trigger: "manual", resumeTaskStatus: resume, scheduledFor: task.scheduledTime }, "completed", now);
      assert.equal(task.status, resume);
      assert.equal(task.scheduledTime, "2026-11-01T12:00:00.000Z");
    }
    const finished = base();
    settleScheduledTaskAfterRun(finished, { trigger: "manual", resumeTaskStatus: "completed" }, "failed", now);
    assert.equal(finished.status, "failed");
  });

  await t.test("a time the user set during the run wins over the next computed time", () => {
    const task = { ...base(), recurrence: { type: "daily" }, scheduledTime: "2026-11-03T08:00:00.000Z" };
    settleScheduledTaskAfterRun(task, { trigger: "scheduled", scheduledFor: "2026-11-01T12:00:00.000Z" }, "completed", now);
    assert.equal(task.status, "pending");
    assert.equal(task.scheduledTime, "2026-11-03T08:00:00.000Z");
  });

  await t.test("a recurring run advances; a one-off finishes", () => {
    const recurring = { ...base(), recurrence: { type: "daily" }, error: "old" };
    settleScheduledTaskAfterRun(recurring, { trigger: "scheduled", scheduledFor: recurring.scheduledTime }, "completed", now);
    assert.equal(recurring.status, "pending");
    assert.equal(recurring.scheduledTime, "2026-11-02T12:00:00.000Z");
    assert.equal(recurring.error, undefined);
    const once = base();
    settleScheduledTaskAfterRun(once, { trigger: "scheduled", scheduledFor: once.scheduledTime }, "failed", now);
    assert.equal(once.status, "failed");
  });
});

test("cancelled tasks can be archived, including recurring ones", () => {
  assert.equal(scheduledTaskCanArchive({ status: "cancelled", recurrence: { type: "daily" } }), true);
  assert.equal(scheduledTaskCanArchive({ status: "pending", recurrence: { type: "daily" } }), false);
  assert.equal(scheduledTaskCanArchive({ status: "completed" }), true);
  assert.equal(scheduledTaskCanArchive({ status: "cancelled", archivedAt: "x" }), false);
});
