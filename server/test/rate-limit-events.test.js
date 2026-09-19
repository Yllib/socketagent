const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClaudeRateLimitEvent,
  buildClaudeUsageRateLimitEvents,
  buildCodexRateLimitEvents,
} = require("../dist/rate-limit-events");

test("Claude rate-limit events preserve window identity and reset time", () => {
  assert.deepEqual(
    buildClaudeRateLimitEvent({
      status: "allowed_warning",
      rateLimitType: "seven_day_opus",
      utilization: 0.91,
      resetsAt: 1785258000,
    }, "session-1"),
    {
      type: "rate_limit_event",
      backend: "claude",
      status: "allowed_warning",
      resetsAt: "2026-07-28T17:00:00.000Z",
      utilization: 0.91,
      utilizationPercent: 91,
      rateLimitType: "seven_day_opus",
      sessionId: "session-1",
    },
  );
});

test("Claude usage snapshots independently surface five-hour and weekly windows", () => {
  const events = buildClaudeUsageRateLimitEvents({
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization: 86,
        resets_at: "2026-07-28T13:00:00.000Z",
      },
      seven_day: {
        utilization: 89,
        resets_at: "2026-08-02T12:00:00.000Z",
      },
      seven_day_opus: {
        utilization: 97,
        resets_at: "2026-08-02T12:00:00.000Z",
      },
    },
  }, "session-1");

  assert.deepEqual(
    events.map((event) => ({
      backend: event.backend,
      type: event.rateLimitType,
      status: event.status,
      utilizationPercent: event.utilizationPercent,
    })),
    [
      {
        backend: "claude",
        type: "five_hour",
        status: "allowed_warning",
        utilizationPercent: 86,
      },
      {
        backend: "claude",
        type: "seven_day_opus",
        status: "allowed_warning",
        utilizationPercent: 97,
      },
    ],
  );
});

test("Claude usage snapshots treat utilization as percentage points", () => {
  const events = buildClaudeUsageRateLimitEvents({
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization: 9,
        resets_at: "2026-07-28T13:00:00.000Z",
      },
      seven_day: {
        utilization: 1,
        resets_at: "2026-08-02T12:00:00.000Z",
      },
    },
  }, "session-1");

  assert.deepEqual(
    events.map((event) => ({
      status: event.status,
      utilization: event.utilization,
      utilizationPercent: event.utilizationPercent,
    })),
    [
      { status: "allowed", utilization: 0.09, utilizationPercent: 9 },
      { status: "allowed", utilization: 0.01, utilizationPercent: 1 },
    ],
  );
});

test("Codex emits independent five-hour and weekly windows", () => {
  const events = buildCodexRateLimitEvents({
    primary: {
      usedPercent: 88,
      windowDurationMins: 300,
      resetsAt: 1785258000,
    },
    secondary: {
      usedPercent: 100,
      windowDurationMins: 10080,
      resetsAt: 1785686400,
    },
  }, "session-1");

  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => ({
      backend: event.backend,
      type: event.rateLimitType,
      status: event.status,
      utilizationPercent: event.utilizationPercent,
      resetsAt: event.resetsAt,
    })),
    [
      {
        backend: "codex",
        type: "five_hour",
        status: "allowed_warning",
        utilizationPercent: 88,
        resetsAt: "2026-07-28T17:00:00.000Z",
      },
      {
        backend: "codex",
        type: "seven_day",
        status: "rejected",
        utilizationPercent: 100,
        resetsAt: "2026-08-02T16:00:00.000Z",
      },
    ],
  );
});

test("Codex treats usedPercent as percentage points at the one-percent boundary", () => {
  const events = buildCodexRateLimitEvents({
    primary: {
      usedPercent: 0.5,
      windowDurationMins: 300,
      resetsAt: 1785768000,
    },
    secondary: {
      usedPercent: 1,
      windowDurationMins: 10080,
      resetsAt: 1786362108,
    },
  }, "session-1");

  assert.deepEqual(
    events.map((event) => ({
      status: event.status,
      utilizationPercent: event.utilizationPercent,
    })),
    [
      { status: "allowed", utilizationPercent: 0.5 },
      { status: "allowed", utilizationPercent: 1 },
    ],
  );
});

// The `limits` array is what a current account actually returns; the named
// seven_day_opus / seven_day_sonnet fields come back null. Payload below is
// copied from a live max-plan response.
const LIVE_LIMITS = [
  { kind: "session", group: "session", percent: 16, severity: "normal", resets_at: "2026-09-19T08:20:00.716056+00:00", scope: null, is_active: false },
  { kind: "weekly_all", group: "weekly", percent: 26, severity: "normal", resets_at: "2026-09-24T13:00:00.716079+00:00", scope: null, is_active: true },
  { kind: "weekly_scoped", group: "weekly", percent: 4, severity: "normal", resets_at: "2026-09-24T12:59:59.716305+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
];

const usage = (limits) => ({ rate_limits_available: true, rate_limits: limits });

test("the normalized limits array is read in preference to the named windows", () => {
  const events = buildClaudeUsageRateLimitEvents(usage({
    five_hour: { utilization: 16, resets_at: "2026-09-19T08:20:00.716056+00:00" },
    seven_day: { utilization: 26, resets_at: "2026-09-24T13:00:00.716079+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: LIVE_LIMITS,
  }), "session-1");

  assert.deepEqual(
    events.map((e) => ({ type: e.rateLimitType, percent: e.utilizationPercent })),
    [{ type: "five_hour", percent: 16 }, { type: "seven_day", percent: 26 }],
  );
  assert.ok(events.every((e) => e.resetsAt), "microsecond+offset timestamps must parse");
});

test("a per-model weekly wins when it is the busiest, and names its model", () => {
  // The window the old code could not see: with the named per-model fields
  // null, a scoped weekly near its limit was dropped for a quieter aggregate.
  const events = buildClaudeUsageRateLimitEvents(usage({
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      LIVE_LIMITS[0],
      { ...LIVE_LIMITS[1], percent: 26 },
      { ...LIVE_LIMITS[2], percent: 97 },
    ],
  }), "session-1");

  const weekly = events.find((e) => e.rateLimitType !== "five_hour");
  assert.equal(weekly.utilizationPercent, 97);
  assert.equal(weekly.status, "allowed_warning");
  assert.equal(weekly.scopeLabel, "Fable");
});

test("accounts still sending only the named windows keep working", () => {
  const events = buildClaudeUsageRateLimitEvents(usage({
    five_hour: { utilization: 16, resets_at: "2026-09-19T08:20:00.000Z" },
    seven_day: { utilization: 26, resets_at: "2026-09-24T13:00:00.000Z" },
  }), "session-1");

  assert.deepEqual(
    events.map((e) => ({ type: e.rateLimitType, percent: e.utilizationPercent })),
    [{ type: "five_hour", percent: 16 }, { type: "seven_day", percent: 26 }],
  );
  assert.equal(events[0].scopeLabel, undefined, "unscoped windows carry no label");
});
