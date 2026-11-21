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
} = require("#server/model-catalog-store");
const { ClaudeSession } = require("#server/claude-session");
const { CodexSession } = require("#server/codex-session");
const { GeminiSession } = require("#server/gemini-session");
const { parseAgyModelsOutput } = require("#server/gemini-cli");

const { parseServerMessage } = require("#server/server-message");

/** @param {import("#server/protocol").ServerMessage[]} sent @returns {import("#server/client-transport").ClientTransport} */
function testSocket(sent) {
  return {
    readyState: 1,
    supportsSessionEventAck: false,
    send(payload) {
      sent.push(parseServerMessage(JSON.parse(payload)));
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

  const { z } = require("zod");
  const stored = z.object({
    schemaVersion: z.number(),
    catalogs: z.object({
      claude: z.unknown().optional(),
      codex: z.object({models: z.array(z.object({value: z.string()}))}),
    }),
  }).parse(JSON.parse(fs.readFileSync(path.join(tempDir, "model-catalogs.json"), "utf8")));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.catalogs.claude, undefined);
  assert.equal(stored.catalogs.codex.models[0].value, "gpt-test");
});

test("Claude sends a fresh cached catalog without starting a query", async () => {
  saveCachedModelCatalog("claude", [{ value: "fable", displayName: "Fable" }]);
  /** @type {import("#server/protocol").ServerMessage[]} */
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
  /** @type {import("#server/protocol").ServerMessage[]} */
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

/**
 * Codex session whose live catalog is `models`, without starting app-server.
 * @param {string} model
 * @param {Array<Record<string, unknown>>} models
 */
async function codexSessionWithCatalog(model, models) {
  saveCachedModelCatalog("codex", [{ value: "gpt-6-sol", displayName: "GPT-6-Sol" }]);
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new CodexSession(testSocket(sent), process.cwd(), []);
  session.sessionId = crypto.randomUUID();
  await session.setModel(model);
  session.listCodexModelRecords = async () => models;
  return { session, sent };
}

test("Codex replaces a model the catalog no longer lists with the default", async () => {
  const { session, sent } = await codexSessionWithCatalog("gpt-5.5", [
    { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true },
    { id: "gpt-6-sol", displayName: "GPT-6-Sol" },
  ]);

  assert.equal(await session.resolveTurnModel(), "gpt-6.1-sol");
  assert.equal(session.sessionModel, "gpt-6.1-sol");
  const card = sent.find((entry) => entry.type === "model_changed");
  assert.equal(card.content, "Codex no longer offers gpt-5.5. Model changed to GPT-6.1-Sol.");
  assert.equal(card.model, "gpt-6.1-sol");
});

test("Codex keeps a hidden model the live catalog still lists", async () => {
  const { session, sent } = await codexSessionWithCatalog("gpt-internal", [
    { id: "gpt-6-sol", displayName: "GPT-6-Sol", isDefault: true },
    { id: "gpt-internal", displayName: "Internal", hidden: true },
  ]);

  assert.equal(await session.resolveTurnModel(), "gpt-internal");
  assert.equal(sent.some((entry) => entry.type === "model_changed"), false);
});

test("Codex records a card with display names when the user switches models", async () => {
  const { session, sent } = await codexSessionWithCatalog("gpt-6-sol", []);
  await session.refreshSupportedModels();

  await session.setModel("gpt-6.1-sol");

  const cards = sent.filter((entry) => entry.type === "model_changed");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].content, "Model changed from GPT-6-Sol to gpt-6.1-sol");
});

test("reads a persisted Gemini model catalog back from disk", () => {
  saveCachedModelCatalog("gemini", [{ value: "gemini-4-neon", displayName: "Gemini 4 Neon", isDefault: true }]);

  const storePath = require.resolve("#server/model-catalog-store");
  delete require.cache[storePath];
  const reloaded = require("#server/model-catalog-store");

  const loaded = reloaded.getCachedModelCatalog("gemini");
  assert.equal(loaded?.models[0]?.value, "gemini-4-neon");
});

test("parseAgyModelsOutput groups multi-effort families and keeps singletons standalone", () => {
  const models = parseAgyModelsOutput([
    "gemini-4-neon-high              Gemini 4 Neon (High)",
    "gemini-4-neon-xhigh             Gemini 4 Neon (XHigh)",
    "gemini-4-neon-low               Gemini 4 Neon (Low)",
    "gemini-pro-orchestrator-neon    Orchestrator (Neon)",
    "gpt-oss-120b-medium             GPT-OSS 120B (Medium)",
  ].join("\n"));

  assert.deepEqual(models, [
    {
      id: "gemini-4-neon",
      value: "gemini-4-neon",
      displayName: "Gemini 4 Neon",
      description: "",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
        { reasoningEffort: "low" },
      ],
      supportedEffortLevels: ["high", "xhigh", "low"],
      defaultReasoningEffort: "high",
    },
    {
      id: "gemini-pro-orchestrator-neon",
      value: "gemini-pro-orchestrator-neon",
      displayName: "Orchestrator (Neon)",
      description: "",
      isDefault: false,
    },
    {
      id: "gpt-oss-120b-medium",
      value: "gpt-oss-120b-medium",
      displayName: "GPT-OSS 120B (Medium)",
      description: "",
      isDefault: false,
    },
  ]);
});

test("Gemini discovers models before a turn when cache is empty, then reuses fresh cache", async () => {
  invalidateCachedModelCatalog("gemini");
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const session = new GeminiSession(testSocket(sent), process.cwd(), []);
  let discoveries = 0;
  session.discoverSupportedModels = async () => {
    discoveries += 1;
    return [
      { id: "gemini-4-neon", value: "gemini-4-neon", displayName: "Gemini 4 Neon", isDefault: true },
    ];
  };

  await session.refreshSupportedModels();

  assert.equal(discoveries, 1);
  const discovered = sent.find((entry) => entry.type === "supported_models");
  assert.equal(discovered?.backend, "gemini");
  assert.equal(discovered?.models[0]?.value, "gemini-4-neon");
  assert.equal(session.sessionModel, "gemini-4-neon");

  /** @type {import("#server/protocol").ServerMessage[]} */
  const sentCached = [];
  const nextSession = new GeminiSession(testSocket(sentCached), process.cwd(), []);
  nextSession.discoverSupportedModels = async () => {
    discoveries += 1;
    return [];
  };

  await nextSession.refreshSupportedModels();

  assert.equal(discoveries, 1);
  const cached = sentCached.find((entry) => entry.type === "supported_models");
  assert.equal(cached?.backend, "gemini");
  assert.equal(cached?.cached, true);
  assert.equal(cached?.models[0]?.value, "gemini-4-neon");
});
