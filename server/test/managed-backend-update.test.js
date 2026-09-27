const assert = require("node:assert/strict");
const test = require("node:test");

const {
  backendsForManagedBackendSpecs,
  managedBackendCheckIsDue,
  managedBackendSpecsNeedingUpdate,
  parseNpmVersionOutput,
} = require("#server/managed-backend-update");

test("checks managed backends on an elapsed cadence instead of once per git commit", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(managedBackendCheckIsDue(0, 10 * hour, 6 * hour), true);
  assert.equal(managedBackendCheckIsDue(8 * hour, 10 * hour, 6 * hour), false);
  assert.equal(managedBackendCheckIsDue(4 * hour, 10 * hour, 6 * hour), true);
});

test("does not reinstall managed backends whose versions are already current", () => {
  assert.deepEqual(managedBackendSpecsNeedingUpdate(
    {
      "@openai/codex": "0.144.6",
      "@anthropic-ai/claude-code": "2.1.215",
    },
    {
      "@openai/codex": "0.144.6",
      "@anthropic-ai/claude-code": "2.1.215",
    },
  ), []);
});

test("installs only missing or outdated managed backends", () => {
  assert.deepEqual(managedBackendSpecsNeedingUpdate(
    {
      "@openai/codex": "0.144.5",
    },
    {
      "@openai/codex": "0.144.6",
      "@anthropic-ai/claude-code": "2.1.215",
    },
  ), ["@openai/codex@latest", "@anthropic-ai/claude-code@latest"]);
});

test("parses npm scalar and version-list responses", () => {
  assert.equal(parseNpmVersionOutput('"0.144.6"'), "0.144.6");
  assert.equal(parseNpmVersionOutput('["0.144.5", "0.144.6"]'), "0.144.6");
  assert.equal(parseNpmVersionOutput("2.1.215"), "2.1.215");
});

test("maps changed managed packages to the model catalogs they invalidate", () => {
  assert.deepEqual(
    backendsForManagedBackendSpecs(["@anthropic-ai/claude-code@latest"]),
    ["claude"],
  );
  assert.deepEqual(
    backendsForManagedBackendSpecs(["@openai/codex@latest", "@anthropic-ai/claude-code@latest"]),
    ["codex", "claude"],
  );
});

test('repeated update triggers share one retry deadline instead of multiplying chains', t => {
  const { ManagedBackendRetry } = require('#server/managed-backend-update');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const retry = new ManagedBackendRetry();
  let calls = 0;
  for (let i = 0; i < 100; i++) retry.schedule(300000, () => calls++);
  assert.equal(retry.isWaiting, true);
  t.mock.timers.tick(299999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  assert.equal(retry.isWaiting, false);
  retry.schedule(300000, () => calls++);
  retry.clear();
  t.mock.timers.tick(300000);
  assert.equal(calls, 1);
});
