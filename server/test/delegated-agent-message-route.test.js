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

test("injects a child completion report immediately without a delivery queue", async () => {
  const calls = [];
  const result = await routeRunningDelegatedAgentMessage({
    target: {
      async injectMessage(...args) {
        calls.push(args);
      },
    },
    isRunning: true,
    prompt: "<socketagent_delegation_report>done</socketagent_delegation_report>",
    messageId: "delegated-report:delegation-1:run-1",
  });

  assert.equal(result, "injected");
  assert.deepEqual(calls, [[
    "<socketagent_delegation_report>done</socketagent_delegation_report>",
    "next",
    "delegated-report:delegation-1:run-1",
  ]]);
});

test("surfaces an injection failure so durable pending state can be the fallback", async () => {
  await assert.rejects(
    routeRunningDelegatedAgentMessage({
      target: {
        async injectMessage() {
          throw new Error("safe boundary unavailable");
        },
      },
      isRunning: true,
      prompt: "child result",
      messageId: "delegated-report:delegation-1:run-2",
    }),
    /safe boundary unavailable/,
  );
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
