const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = path.join(os.tmpdir(), `socketagent-model-cache-${crypto.randomUUID()}`);
process.env.SOCKET_AGENT_DATA_DIR = tempDir;
fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(path.join(tempDir, "model-catalogs.json"), JSON.stringify({
  claude: {
    models: [{ value: "legacy-model", displayName: "Legacy model" }],
    updatedAt: new Date().toISOString(),
  },
}));

const {
  getCachedModelCatalog,
  invalidateCachedModelCatalog,
  modelCatalogIsFresh,
  saveCachedModelCatalog,
} = require("../dist/model-catalog-store");
const { ClaudeSession } = require("../dist/claude-session");
const { CodexSession } = require("../dist/codex-session");

function testSocket(sent) {
  return {
    readyState: 1,
    supportsSessionEventAck: false,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("treats the legacy cache format as stale after a harness-aware rollout", () => {
  assert.equal(getCachedModelCatalog("claude"), undefined);
});

test("persists defensive copies of backend model catalogs", () => {
  const original = [{ value: "sonnet", displayName: "Sonnet" }];
  saveCachedModelCatalog("claude", original, "2026-07-15T12:00:00.000Z");
  original[0].value = "mutated";

  const loaded = getCachedModelCatalog("claude");
  assert.equal(loaded.models[0].value, "sonnet");
  loaded.models[0].value = "also-mutated";
  assert.equal(getCachedModelCatalog("claude").models[0].value, "sonnet");
});

test("recognizes fresh and stale catalogs", () => {
  assert.equal(modelCatalogIsFresh({ models: [{}], updatedAt: new Date().toISOString() }), true);
  assert.equal(modelCatalogIsFresh({ models: [{}], updatedAt: "2020-01-01T00:00:00.000Z" }), false);
});

test("invalidates only the updated backend catalog and persists the result", () => {
  saveCachedModelCatalog("claude", [{ value: "opus", displayName: "Opus" }]);
  saveCachedModelCatalog("codex", [{ value: "gpt-test", displayName: "GPT Test" }]);

  invalidateCachedModelCatalog("claude");

  assert.equal(getCachedModelCatalog("claude"), undefined);
  assert.equal(getCachedModelCatalog("codex").models[0].value, "gpt-test");

  const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "model-catalogs.json"), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.catalogs.claude, undefined);
  assert.equal(stored.catalogs.codex.models[0].value, "gpt-test");
});

test("Claude sends a fresh cached catalog without starting a query", async () => {
  saveCachedModelCatalog("claude", [{ value: "fable", displayName: "Fable" }]);
  const sent = [];
  const session = new ClaudeSession(testSocket(sent), process.cwd(), []);

  await session.refreshSupportedModels();

  const message = sent.find((entry) => entry.type === "supported_models");
  assert.equal(message.backend, "claude");
  assert.equal(message.cached, true);
  assert.equal(message.models[0].value, "fable");
});

test("Codex sends a fresh cached catalog without starting app-server", async () => {
  saveCachedModelCatalog("codex", [{ value: "gpt-test", displayName: "GPT Test" }]);
  const sent = [];
  const session = new CodexSession(testSocket(sent), process.cwd(), []);

  await session.refreshSupportedModels();

  const message = sent.find((entry) => entry.type === "supported_models");
  assert.equal(message.backend, "codex");
  assert.equal(message.cached, true);
  assert.equal(message.models[0].value, "gpt-test");
  assert.equal(session.sessionModel, "gpt-test");
  assert.equal(session.appServer, null);
});
