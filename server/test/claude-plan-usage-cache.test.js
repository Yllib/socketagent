const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDir = fs.mkdtempSync(
  path.join(os.tmpdir(), `socketagent-plan-usage-${crypto.randomUUID()}-`),
);
process.env.SOCKET_AGENT_DATA_DIR = testDir;

const {
  lastClaudePlanUsage,
  rememberClaudePlanUsage,
  resetClaudePlanUsageCacheForTests,
} = require("#server/claude-plan-usage-cache");

test.after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("the last plan usage survives a restart with the time it was read", () => {
  const usage = { rate_limits_available: true, subscription_type: "max" };
  rememberClaudePlanUsage(usage, new Date("2026-10-10T20:00:00.000Z"));
  resetClaudePlanUsageCacheForTests();
  assert.deepEqual(lastClaudePlanUsage(), {
    usage,
    fetchedAt: "2026-10-10T20:00:00.000Z",
  });

  rememberClaudePlanUsage(null);
  resetClaudePlanUsageCacheForTests();
  assert.equal(lastClaudePlanUsage().usage.subscription_type, "max");
});
