const { parseServerMessage } = require("#server/server-message");
const assert = require("node:assert/strict"), test = require("node:test"), crypto = require("node:crypto");
require("./test-data-dir");
const { CodexSession } = require("#server/codex-session");

/** @type {CodexSession[]} */
const sessions = [];
test.afterEach(() => { for (const s of sessions.splice(0)) {
  clearTimeout(s.appServerIdleStopTimer);
  clearTimeout(s.pendingAppServerTurnCompletion);
} });

function fixture() {
  const s = new CodexSession({ readyState: 1, send: (/** @type {string} */ v) => parseServerMessage(JSON.parse(v)) }, "/tmp");
  sessions.push(s);
  s.sessionId = s.threadId = `lineage-${crypto.randomUUID()}`;
  return s;
}

test("active turn lineage follows the turn Codex reports and clears when the turn ends", () => {
  const s = fixture();
  assert.equal(s.activeTurnLineage, null);
  s.handleAppServerNotification("turn/started", { threadId: s.threadId, turn: { id: "t2", rootTurnId: "t1" } });
  assert.deepEqual(s.activeTurnLineage, { parentTurnId: "t2", rootTurnId: "t1" });
  s.handleAppServerNotification("turn/completed", { threadId: s.threadId, turn: { id: "t2", status: "completed" } });
  assert.equal(s.activeTurnLineage, null);
  // Older history reports no root, so the turn is its own root.
  s.handleAppServerNotification("turn/started", { threadId: s.threadId, turn: { id: "t3", rootTurnId: null } });
  assert.deepEqual(s.activeTurnLineage, { parentTurnId: "t3", rootTurnId: "t3" });
});

test("turn/start carries the supervisor's turn only for delegated work", () => {
  const s = fixture();
  const direct = s.appServerTurnStartParams(s.threadId, "hello", "m1", undefined);
  assert.equal("parentTurnId" in direct, false);
  assert.equal("rootTurnId" in direct, false);
  s._currentParentTurn = { parentTurnId: "p1", rootTurnId: "r1" };
  const delegated = s.appServerTurnStartParams(s.threadId, "hello", "m1", undefined);
  assert.equal(delegated.parentTurnId, "p1");
  assert.equal(delegated.rootTurnId, "r1");
  assert.equal(delegated.threadId, s.threadId);
});
