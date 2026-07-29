const assert = require("node:assert/strict");
const test = require("node:test");

const {
  routeMonitorOutputToSession,
} = require("../dist/monitor-output-route");

function fakeSession(id, running = false) {
  return {
    isRunning: running,
    injected: [],
    queries: [],
    getSessionId: () => id,
    async injectMessage(text, priority) {
      this.injected.push({ text, priority });
    },
    async runQuery(text, sessionId) {
      this.queries.push({ text, sessionId });
    },
  };
}

test("idle Monitor output stays bound to its owning session", async () => {
  const owner = fakeSession("owner-session");
  const unrelated = fakeSession("other-session");
  let activeSession = owner;
  const completed = [];

  // Reproduce the original race: the user opens another session after the
  // Monitor starts but before its output is delivered.
  activeSession = unrelated;
  await routeMonitorOutputToSession(owner, "monitor result", {
    afterIdleRun: (session) => completed.push(session.getSessionId()),
  });

  assert.equal(activeSession, unrelated);
  assert.deepEqual(owner.queries, [{
    text: "monitor result",
    sessionId: "owner-session",
  }]);
  assert.deepEqual(unrelated.queries, []);
  assert.deepEqual(completed, ["owner-session"]);
});

test("running Monitor owner receives an injection without touching another session", async () => {
  const owner = fakeSession("owner-session", true);
  const unrelated = fakeSession("other-session", true);

  await routeMonitorOutputToSession(owner, "monitor result");

  assert.deepEqual(owner.injected, [{
    text: "monitor result",
    priority: "next",
  }]);
  assert.deepEqual(unrelated.injected, []);
});
