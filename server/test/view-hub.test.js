const assert = require("node:assert/strict");
const test = require("node:test");

const { z } = require("zod");
const { ViewHub, parseViewSet } = require("#server/view-hub");

const message = z.union([
  z.object({
    type: z.literal("view_transition"),
    start: z.number(),
    end: z.number(),
    setVersion: z.number(),
    updates: z.array(z.object({
      queryId: z.number(),
      hash: z.string(),
      value: z.unknown().optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
      upsert: z.array(z.object({ entryId: z.string(), revision: z.number(), text: z.string() })).optional(),
      remove: z.array(z.string()).optional(),
    })),
    failed: z.array(z.object({ queryId: z.number(), error: z.string() })),
  }),
  z.object({ type: z.literal("view_error"), reason: z.string(), expected: z.number() }),
]);

/** @param {{ sessions: unknown[] }} state */
function hub(state) {
  return new ViewHub({
    sessions: () => ({ kind: "value", key: "", compute: () => ({ sessions: state.sessions }) }),
  });
}

function client() {
  /** @type {z.infer<typeof message>[]} */
  const received = [];
  return { received, send: (/** @type {string} */ json) => { received.push(message.parse(JSON.parse(json))); } };
}

/** @param {z.infer<typeof message> | undefined} received */
function transition(received) {
  if (received?.type !== "view_transition") throw new Error("Expected a view transition");
  return received;
}

test("subscribing sends the value, and a matching hash after reconnect skips it", () => {
  const state = { sessions: [{ id: "a" }] };
  const views = hub(state);
  const owner = {};
  const first = client();
  views.applySet(owner, undefined, first.send, { type: "view_set", version: 1, add: [{ queryId: 1, view: "sessions" }] });
  const opened = transition(first.received[0]);
  assert.deepEqual([opened.start, opened.end, opened.setVersion], [0, 1, 1]);
  assert.deepEqual(opened.updates[0].value, { sessions: [{ id: "a" }] });

  views.dropOwner(owner);
  const second = client();
  views.applySet(owner, undefined, second.send, {
    type: "view_set", version: 1, reset: true,
    add: [{ queryId: 1, view: "sessions", knownHash: opened.updates[0].hash }],
  });
  const resumed = transition(second.received[0]);
  assert.equal(resumed.updates[0].value, undefined);
  assert.equal(resumed.updates[0].hash, opened.updates[0].hash);
});

test("publish sends only changed values, chained, and only to subscribers", () => {
  const state = { sessions: [] };
  const views = hub(state);
  const phone = client();
  const other = client();
  views.applySet({}, "peer-1", phone.send, { type: "view_set", version: 1, add: [{ queryId: 4, view: "sessions" }] });
  views.applySet({}, undefined, other.send, { type: "view_set", version: 1, add: [] });

  views.publish("sessions", "", { sessions: [] });
  assert.equal(phone.received.length, 1, "unchanged value is not resent");

  views.publish("sessions", "", { sessions: [{ id: "b" }] });
  const change = transition(phone.received[1]);
  assert.deepEqual([change.start, change.end], [1, 2]);
  assert.deepEqual(change.updates, [{ queryId: 4, hash: change.updates[0].hash, value: { sessions: [{ id: "b" }] } }]);
  assert.equal(other.received.length, 1, "a connection without the query gets nothing");
});

test("an out-of-order set asks the app to reset, and unknown views fail alone", () => {
  const views = hub({ sessions: [] });
  const owner = {};
  const phone = client();
  views.applySet(owner, undefined, phone.send, { type: "view_set", version: 2, add: [] });
  assert.deepEqual(phone.received[0], { type: "view_error", reason: "set_version", expected: 1 });

  views.applySet(owner, undefined, phone.send, {
    type: "view_set", version: 1, add: [{ queryId: 1, view: "nope" }, { queryId: 2, view: "sessions" }],
  });
  const added = transition(phone.received[1]);
  assert.deepEqual(added.failed, [{ queryId: 1, error: "Unknown view nope" }]);
  assert.equal(added.updates[0].queryId, 2);
  assert.equal(views.subscribed(owner, undefined, "sessions"), true);

  views.applySet(owner, undefined, phone.send, { type: "view_set", version: 2, remove: [2] });
  assert.equal(views.subscribed(owner, undefined, "sessions"), false);
});

test("parseViewSet rejects malformed sets", () => {
  assert.equal(typeof parseViewSet({ version: 0 }), "string");
  assert.equal(typeof parseViewSet({ version: 1, add: [{ queryId: "1", view: "sessions" }] }), "string");
  assert.deepEqual(parseViewSet({ version: 1, add: [{ queryId: 1, view: "status", knownHash: "h" }] }), {
    type: "view_set", version: 1, reset: false, add: [{ queryId: 1, view: "status", args: undefined, knownHash: "h" }], remove: [],
  });
});

/** @param {{ entryId: string, revision: number, text: string }[]} rows */
function transcriptHub(rows) {
  return new ViewHub({
    transcript: () => ({ kind: "rows", key: "s1", compute: () => ({ meta: { count: rows.length }, rows }) }),
  });
}

test("a row view sends every row first, then only changed and removed rows", async () => {
  const rows = [{ entryId: "a", revision: 1, text: "hi" }, { entryId: "b", revision: 1, text: "there" }];
  const views = transcriptHub(rows);
  const phone = client();
  views.applySet({}, undefined, phone.send, { type: "view_set", version: 1, add: [{ queryId: 1, view: "transcript" }] });
  const first = transition(phone.received[0]).updates[0];
  assert.deepEqual(first.upsert?.map((row) => row.entryId), ["a", "b"]);
  assert.deepEqual(first.remove, []);

  rows[1] = { entryId: "b", revision: 2, text: "there!" };
  rows.shift();
  rows.push({ entryId: "c", revision: 1, text: "new" });
  views.invalidate("transcript", "s1");
  views.invalidate("transcript", "s1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(phone.received.length, 2, "two invalidations in one tick make one transition");
  const patch = transition(phone.received[1]).updates[0];
  assert.deepEqual(patch.upsert?.map((row) => `${row.entryId}:${row.revision}`), ["b:2", "c:1"]);
  assert.deepEqual(patch.remove, ["a"]);
  assert.deepEqual(patch.meta, { count: 2 });

  views.invalidate("transcript", "other-session");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(phone.received.length, 2, "another session's writes send nothing");
});

test("a row view resumes from the rows the app holds", () => {
  const rows = [{ entryId: "a", revision: 1, text: "hi" }, { entryId: "b", revision: 3, text: "there" }];
  const views = transcriptHub(rows);
  const phone = client();
  views.applySet({}, undefined, phone.send, {
    type: "view_set", version: 1, reset: true,
    add: [{ queryId: 1, view: "transcript", known: ["a:1", "b:2", "gone:1"] }],
  });
  const patch = transition(phone.received[0]).updates[0];
  assert.deepEqual(patch.upsert?.map((row) => `${row.entryId}:${row.revision}`), ["b:3"]);
  assert.deepEqual(patch.remove, ["gone"]);

  const again = client();
  views.applySet({}, undefined, again.send, {
    type: "view_set", version: 1, reset: true,
    add: [{ queryId: 1, view: "transcript", knownHash: patch.hash }],
  });
  const confirmed = transition(again.received[0]).updates[0];
  assert.equal(confirmed.upsert, undefined);
  assert.equal(confirmed.hash, patch.hash);
});
