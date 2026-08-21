const assert = require("node:assert/strict");
const test = require("node:test");

const { SessionInstanceRegistry } = require("../dist/session-instance-registry");

test("retains every live runner for one exact session ID", () => {
  const registry = new SessionInstanceRegistry();
  const first = {};
  const escaped = {};
  const child = {};

  registry.setActive("parent", first, true);
  registry.setActive("parent", escaped, true);
  registry.setActive("child", child, true);

  assert.deepEqual(new Set(registry.instances("parent")), new Set([first, escaped]));
  assert.deepEqual(registry.instances("child"), [child]);
});

test("removing or rekeying a runner cannot affect child sessions", () => {
  const registry = new SessionInstanceRegistry();
  const parent = {};
  const child = {};
  registry.setActive("temporary", parent, true);
  registry.setActive("child", child, true);

  registry.rekey(parent, "temporary", "parent");
  registry.setActive("parent", parent, false);

  assert.deepEqual(registry.instances("temporary"), []);
  assert.deepEqual(registry.instances("parent"), []);
  assert.deepEqual(registry.instances("child"), [child]);
});

test("candidate extras are deduplicated", () => {
  const registry = new SessionInstanceRegistry();
  const runner = {};
  registry.setActive("session", runner, true);
  assert.deepEqual(registry.instances("session", [runner, runner]), [runner]);
});

test("allInstances deduplicates runners registered under more than one ID", () => {
  const registry = new SessionInstanceRegistry();
  const shared = {};
  const other = {};
  registry.setActive("old", shared, true);
  registry.setActive("new", shared, true);
  registry.setActive("other", other, true);

  assert.deepEqual(new Set(registry.allInstances()), new Set([shared, other]));
});
