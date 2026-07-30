const assert = require("node:assert/strict");
const test = require("node:test");

const {
  routeRunningDelegatedAgentMessage,
} = require("../dist/delegated-agent-message-route");

test("injects a message into a running delegated child at the next safe boundary", async () => {
  const calls = [];
  const result = await routeRunningDelegatedAgentMessage({
    target: {
      async injectMessage(...args) {
        calls.push(args);
      },
    },
    isRunning: true,
    prompt: "Add this requirement while you continue.",
    messageId: "delegated-message:test",
  });

  assert.equal(result, "injected");
  assert.deepEqual(calls, [[
    "Add this requirement while you continue.",
    "next",
    "delegated-message:test",
  ]]);
});

test("starts a normal follow-up turn when the delegated child is idle", async () => {
  const calls = [];
  const result = await routeRunningDelegatedAgentMessage({
    target: {
      async injectMessage(...args) {
        calls.push(args);
      },
    },
    isRunning: false,
    prompt: "Review the next change.",
    messageId: "delegated-message:idle",
  });

  assert.equal(result, "start_turn");
  assert.deepEqual(calls, []);
});
