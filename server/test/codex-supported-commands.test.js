const { parseServerMessage } = require("#server/server-message");
const assert = require("node:assert/strict"), test = require("node:test"), crypto = require("node:crypto");
require("./test-data-dir");
const { CodexSession, buildCodexSupportedCommands, CODEX_NATIVE_SLASH_COMMANDS } = require("#server/codex-session");

/** @type {CodexSession[]} */
const sessions = [];
test.afterEach(() => { for (const s of sessions.splice(0)) {
  clearTimeout(s.appServerIdleStopTimer);
  clearTimeout(s.skillsChangedTimer);
} });

const skill = (/** @type {string} */ name, /** @type {Partial<import("#server/generated/codex/types/v2/SkillMetadata").SkillMetadata>} */ extra = {}) => ({
  name, description: `${name} description`, path: `/skills/${name}/SKILL.md`, scope: "user", enabled: true, pluginId: null, ...extra,
});

test("picker entries: native commands, then enabled skills with the scope a mention resolves to", () => {
  const commands = buildCodexSupportedCommands([
    skill("review-agent", { scope: "system", interface: { displayName: "Review Agent", shortDescription: "Find bugs", iconSmallUrl: null, iconLargeUrl: null } }),
    skill("unslop", { description: "Cut AI tells" }),
    skill("unslop", { scope: "repo", path: "/repo/.codex/skills/unslop/SKILL.md" }),
    skill("hidden", { enabled: false }),
    skill("status"),
  ], [
    { pluginName: "Default templates", skills: [
      { name: "artifact-template-business-review", description: "long", shortDescription: "Create presentations", interface: null, path: null, enabled: true },
      { name: "unslop", description: "plugin copy", shortDescription: null, interface: null, path: null, enabled: true },
    ] },
  ]);
  assert.deepEqual(commands.slice(0, CODEX_NATIVE_SLASH_COMMANDS.length).map((c) => [c.name, c.kind]),
    CODEX_NATIVE_SLASH_COMMANDS.map((c) => [c.name, "command"]));
  const skills = commands.filter((c) => c.kind === "skill");
  assert.deepEqual(skills.map((c) => c.name), ["unslop", "review-agent", "artifact-template-business-review"]);
  const unslop = skills.find((c) => c.name === "unslop");
  assert.equal(unslop.path, "/repo/.codex/skills/unslop/SKILL.md");
  assert.equal(unslop.scope, "repo");
  const review = skills.find((c) => c.name === "review-agent");
  assert.equal(review.description, "Find bugs");
  assert.equal(review.displayName, "Review Agent");
  const template = skills.find((c) => c.name === "artifact-template-business-review");
  assert.equal(template.path, undefined);
  assert.equal(template.pluginName, "Default templates");
  assert.equal(template.description, "Create presentations");
  assert.ok(commands.every((c) => c.agent === "codex"));
});

test("a chosen skill becomes a skill input, or a $mention when Codex has no path for it", () => {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const s = new CodexSession({ readyState: 1, send: (/** @type {string} */ v) => sent.push(parseServerMessage(JSON.parse(v))) }, "/tmp");
  sessions.push(s);
  s.sessionId = s.threadId = `commands-${crypto.randomUUID()}`;
  s.codexSkillIndex = new Map([
    ["unslop", { name: "unslop", kind: "skill", agent: "codex", description: "", path: "/home/me/.codex/skills/unslop/SKILL.md" }],
    ["plugin-management", { name: "plugin-management", kind: "skill", agent: "codex", description: "", pluginName: "Plugin Management" }],
  ]);
  const local = s.buildAppServerTurnInput("/unslop tidy this paragraph");
  assert.deepEqual(local[0], { type: "skill", name: "unslop", path: "/home/me/.codex/skills/unslop/SKILL.md" });
  assert.equal(local[1].type, "text");
  assert.match(local[1].text, /tidy this paragraph/);

  const remote = s.buildAppServerTurnInput("/plugin-management list my plugins");
  assert.equal(remote.length, 1);
  assert.equal(remote[0].type, "text");
  assert.match(remote[0].text, /^\$plugin-management list my plugins/);

  const bare = s.buildAppServerTurnInput("/Plugin-Management");
  assert.equal(bare[0].type, "text");
  assert.match(bare[0].type === "text" ? bare[0].text : "", /^\$plugin-management$/m);

  const plain = s.buildAppServerTurnInput("/not-a-skill at all");
  assert.equal(plain.length, 1);
  assert.equal(plain[0].type, "text");
  assert.match(plain[0].type === "text" ? plain[0].text : "", /^\/not-a-skill at all/);
});

test("supported_commands is sent once per change and replayed to a client that attaches", async () => {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const s = new CodexSession({ readyState: 1, send: (/** @type {string} */ v) => sent.push(parseServerMessage(JSON.parse(v))) }, "/tmp");
  sessions.push(s);
  s.sessionId = s.threadId = `commands-${crypto.randomUUID()}`;
  s.appServer = {
    listSkills: async () => ({ data: [{ cwd: "/tmp", skills: [skill("unslop")], errors: [] }] }),
    listInstalledPlugins: async () => ({ marketplaces: [], marketplaceLoadErrors: [] }),
    stop: async () => {},
    removeAllListeners: () => {},
  };
  s.appServerInitialized = true;
  await s.refreshSupportedCommands();
  await s.refreshSupportedCommands();
  const messages = sent.filter((m) => m.type === "supported_commands");
  assert.equal(messages.length, 1);
  assert.ok(messages[0].commands.some((c) => c.name === "unslop" && c.kind === "skill"));
  assert.ok(messages[0].commands.some((c) => c.name === "goal" && c.kind === "command"));

  /** @type {import("#server/protocol").ServerMessage[]} */
  const replayed = [];
  s.replayLiveState({ readyState: 1, send: (/** @type {string} */ v) => replayed.push(parseServerMessage(JSON.parse(v))) });
  assert.equal(replayed.filter((m) => m.type === "supported_commands").length, 1);
});
