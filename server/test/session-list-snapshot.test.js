const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mergeSessionListBase,
  createNativeRefreshCoordinator,
} = require("../dist/session-list-snapshot");

function session(id, overrides = {}) {
  return {
    id,
    title: `title-${id}`,
    messagePreview: `preview-${id}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActive: "2026-09-18T12:00:00.000Z",
    ...overrides,
  };
}

const ids = (sessions) => sessions.map((s) => s.id);

test("an archived session left in the native snapshot stays out of the list", () => {
  // The archive handler drops the session from the store and invalidates the
  // native caches, but the snapshot is whatever the last scan produced.
  const merged = mergeSessionListBase(
    [session("kept")],
    [session("kept"), session("archived")],
    new Set(["archived"]),
  );
  assert.deepEqual(ids(merged), ["kept"]);
});

test("an archived session still in the store stays out of the list", () => {
  const merged = mergeSessionListBase(
    [session("kept"), session("archived")],
    [session("kept")],
    new Set(["archived"]),
  );
  assert.deepEqual(ids(merged), ["kept"]);
});

test("archived ids are honoured with no native snapshot yet", () => {
  const merged = mergeSessionListBase(
    [session("kept"), session("archived")],
    null,
    new Set(["archived"]),
  );
  assert.deepEqual(ids(merged), ["kept"]);
});

test("stored fields win, except where the store has nothing worth showing", () => {
  const stored = [session("a", {
    title: "Untitled",
    messagePreview: "",
    cwd: "/stored",
  })];
  const native = [session("a", {
    title: "Native title",
    messagePreview: "Native preview",
    cwd: "/native",
  })];
  const [merged] = mergeSessionListBase(stored, native, new Set());
  assert.equal(merged.title, "Native title");
  assert.equal(merged.messagePreview, "Native preview");
  assert.equal(merged.cwd, "/stored");
});

test("merged list is newest first", () => {
  const merged = mergeSessionListBase(
    [session("old", { lastActive: "2026-09-01T00:00:00.000Z" })],
    [session("new", { lastActive: "2026-09-18T00:00:00.000Z" })],
    new Set(),
  );
  assert.deepEqual(ids(merged), ["new", "old"]);
});

/** Resolves only when release() is called, so a scan can be held open. */
function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a request during a scan re-runs it afterwards", async () => {
  const reasons = [];
  const gate = deferred();
  const request = createNativeRefreshCoordinator(async (reason) => {
    reasons.push(reason);
    if (reasons.length === 1) await gate.promise;
  });

  request("first");
  request("archive");
  assert.deepEqual(reasons, ["first"], "second request must not run concurrently");

  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ["first", "archive"]);
});

test("many requests during one scan collapse into a single re-run", async () => {
  const reasons = [];
  const gate = deferred();
  const request = createNativeRefreshCoordinator(async (reason) => {
    reasons.push(reason);
    if (reasons.length === 1) await gate.promise;
  });

  request("first");
  request("second");
  request("third");
  request("last");

  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ["first", "last"]);
});

test("a failed scan does not wedge the coordinator", async () => {
  const reasons = [];
  const request = createNativeRefreshCoordinator(async (reason) => {
    reasons.push(reason);
    throw new Error("scan failed");
  });

  request("first");
  await new Promise((resolve) => setImmediate(resolve));
  request("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ["first", "second"]);
});

// ── Timestamp agreement with the native scan ──
//
// The app sorts on lastActive and the two lists alternate every couple of
// seconds, so a disagreement reshuffles the list under the user's finger.

const { newestIso } = require("../dist/session-list-snapshot");

test("lastActive takes the newest of stored and native, as the native scan does", () => {
  const stored = [session("a", { lastActive: "2026-09-14T16:00:11.000Z" })];
  const native = [session("a", { lastActive: "2026-09-17T16:00:05.526Z" })];
  const [merged] = mergeSessionListBase(stored, native, new Set());
  assert.equal(merged.lastActive, "2026-09-17T16:00:05.526Z");
  assert.equal(merged.lastActive, newestIso(["2026-09-14T16:00:11.000Z"], "2026-09-17T16:00:05.526Z"));
});

test("a newer stored lastActive still wins", () => {
  const stored = [session("a", { lastActive: "2026-09-18T00:00:00.000Z" })];
  const native = [session("a", { lastActive: "2026-09-01T00:00:00.000Z" })];
  assert.equal(mergeSessionListBase(stored, native, new Set())[0].lastActive, "2026-09-18T00:00:00.000Z");
});

test("createdAt prefers the stored value and falls back to native", () => {
  const native = [session("a", { createdAt: "2026-09-08T22:12:33.000Z" })];
  assert.equal(
    mergeSessionListBase([session("a", { createdAt: "2026-07-14T13:36:05.372Z" })], native, new Set())[0].createdAt,
    "2026-07-14T13:36:05.372Z",
  );
  assert.equal(
    mergeSessionListBase([session("a", { createdAt: "" })], native, new Set())[0].createdAt,
    "2026-09-08T22:12:33.000Z",
  );
});

test("a session's sort key does not change between the two list shapes", () => {
  // The exact flap seen in the wild: 43 of 82 rows alternating every broadcast.
  const stored = [session("wakespeed", { lastActive: "2026-09-14T16:00:11.000Z" })];
  const native = [session("wakespeed", { lastActive: "2026-09-17T16:00:05.526Z" })];
  const immediate = mergeSessionListBase(stored, native, new Set())[0];
  // What listSessionsWithNativeBackends produces for the same session.
  const fromNativeScan = newestIso([stored[0].lastActive], native[0].lastActive);
  assert.equal(immediate.lastActive, fromNativeScan);
});
