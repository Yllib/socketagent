const assert = require("node:assert/strict");
const test = require("node:test");

const { HardAbortCoordinator } = require("../dist/hard-abort");

test("concurrent and repeated hard-abort requests terminate a session once", async () => {
  const coordinator = new HardAbortCoordinator(1000);
  let abortCalls = 0;
  let target = {
    async abort() {
      abortCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
  const lookup = () => target;
  const remove = (session) => {
    if (target === session) target = null;
  };

  const [first, duplicate] = await Promise.all([
    coordinator.abort("request-1", "session-1", lookup, remove),
    coordinator.abort("request-1", "session-1", lookup, remove),
  ]);
  const replay = await coordinator.abort("request-1", "session-1", lookup, remove);

  assert.equal(abortCalls, 1);
  assert.deepEqual(first, { stopped: true, alreadyStopped: false });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(replay, first);
});

test("hard abort acknowledges a session that is already absent", async () => {
  const coordinator = new HardAbortCoordinator(1000);
  const result = await coordinator.abort(
    "request-2",
    "session-2",
    () => null,
    () => assert.fail("nothing should be removed"),
  );
  assert.deepEqual(result, { stopped: true, alreadyStopped: true });
});

test("a failed termination is not cached and can be retried", async () => {
  const coordinator = new HardAbortCoordinator(1000);
  let calls = 0;
  const target = {
    async abort() {
      calls++;
      if (calls === 1) throw new Error("temporary failure");
    },
  };

  await assert.rejects(
    coordinator.abort("request-3", "session-3", () => target, () => {}),
    /temporary failure/,
  );
  const result = await coordinator.abort(
    "request-3",
    "session-3",
    () => target,
    () => {},
  );
  assert.equal(calls, 2);
  assert.equal(result.stopped, true);
});
