const assert = require("node:assert/strict");
const test = require("node:test");

const { LatestSnapshotDispatcher } = require("../dist/latest-snapshot-dispatcher");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("snapshot dispatcher sends the first frame and latest queued revision", async () => {
  const sent = [];
  const dispatcher = new LatestSnapshotDispatcher((message) => sent.push(message), 20);

  dispatcher.push("text:stream-1", { revision: 1, content: "a" });
  dispatcher.push("text:stream-1", { revision: 2, content: "ab" });
  dispatcher.push("text:stream-1", { revision: 3, content: "abc" });

  assert.deepEqual(sent.map((message) => message.revision), [1]);
  await wait(35);
  assert.deepEqual(sent.map((message) => message.revision), [1, 3]);
  dispatcher.dispose();
});

test("discard prevents a stale queued snapshot after a final frame", async () => {
  const sent = [];
  const dispatcher = new LatestSnapshotDispatcher((message) => sent.push(message), 20);

  dispatcher.push("text:stream-1", { revision: 1 });
  dispatcher.push("text:stream-1", { revision: 2 });
  dispatcher.discard("text:stream-1");
  sent.push({ revision: 3, final: true });

  await wait(35);
  assert.deepEqual(sent.map((message) => message.revision), [1, 3]);
  dispatcher.dispose();
});
