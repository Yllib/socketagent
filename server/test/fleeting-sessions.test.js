const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SOCKETAGENT_SESSION_STORE_FLUSH_MS = "60000";
require("./test-data-dir");
const {
  FLEETING_IDLE_MS,
  expiredFleetingSessions,
  fleetingExpiresAt,
  requireStartLifetime,
} = require("#server/fleeting-sessions");
const { getSession, makeSessionPermanent, saveSession } = require("#server/session-store");
const { sessionListSummary } = require("#server/session-list-snapshot");

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** @param {string} id @param {Partial<import("#server/protocol").SessionInfo>} [overrides] @returns {import("#server/protocol").SessionInfo} */
function session(id, overrides = {}) {
  return {
    id,
    title: id,
    cwd: "/tmp",
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActive: new Date(NOW - 7 * HOUR).toISOString(),
    messagePreview: "",
    ...overrides,
  };
}

test("the sweep expires idle fleeting sessions and spares running, permanent and recent ones", () => {
  const sessions = [
    session("idle-fleeting", { lifetime: "fleeting" }),
    session("running-fleeting", { lifetime: "fleeting" }),
    session("permanent", { lifetime: "permanent" }),
    session("legacy-no-lifetime"),
    session("recent-fleeting", { lifetime: "fleeting", lastActive: new Date(NOW - 5 * HOUR).toISOString() }),
    // Stale lastActive, but the logical run finished an hour ago.
    session("just-finished-fleeting", {
      lifetime: "fleeting",
      runStats: { completedCount: 1, totalDurationMs: 1, lastCompletedAt: new Date(NOW - HOUR).toISOString() },
    }),
  ];
  const expired = expiredFleetingSessions(sessions, {
    now: NOW,
    isBusy: (candidate) => candidate.id === "running-fleeting",
  });
  assert.deepEqual(expired.map((entry) => entry.id), ["idle-fleeting"]);
});

test("a fleeting session expires exactly six hours after it went idle", () => {
  const idle = session("f", { lifetime: "fleeting", lastActive: new Date(NOW - FLEETING_IDLE_MS).toISOString() });
  assert.deepEqual(expiredFleetingSessions([idle], { now: NOW - 1, isBusy: () => false }), []);
  assert.equal(expiredFleetingSessions([idle], { now: NOW, isBusy: () => false }).length, 1);
});

test("the list carries the deletion time for idle fleeting sessions only", () => {
  const fleeting = session("f", { lifetime: "fleeting" });
  const expiresAt = fleetingExpiresAt(fleeting);
  assert.equal(expiresAt, new Date(NOW - 7 * HOUR + FLEETING_IDLE_MS).toISOString());
  assert.equal(fleetingExpiresAt(session("p")), undefined);
  assert.equal(fleetingExpiresAt(session("p", { lifetime: "permanent" })), undefined);

  const summary = sessionListSummary({ ...fleeting, expiresAt });
  assert.equal(summary.lifetime, "fleeting");
  assert.equal(summary.expiresAt, expiresAt);
  assert.equal(sessionListSummary(session("p")).lifetime, undefined);
});

test("make permanent clears the lifetime one way and reports unknown sessions", () => {
  saveSession(session("keep-me", { lifetime: "fleeting" }));
  assert.equal(makeSessionPermanent("keep-me"), true);
  assert.equal(getSession("keep-me").lifetime, undefined);
  assert.equal(makeSessionPermanent("keep-me"), true, "already permanent is not an error");
  assert.equal(makeSessionPermanent("never-existed"), false);
});

test("AgentSession start refuses a call that does not name the child's lifetime", () => {
  assert.equal(requireStartLifetime({ lifetime: "fleeting" }), "fleeting");
  assert.equal(requireStartLifetime({ lifetime: "permanent" }), "permanent");
  for (const args of [{}, { lifetime: undefined }, { lifetime: "forever" }]) {
    assert.throws(() => requireStartLifetime(args), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /lifetime/);
      assert.match(error.message, /"fleeting"/);
      assert.match(error.message, /"permanent"/);
      return true;
    });
  }
});
