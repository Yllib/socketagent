const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-html-plans-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  deleteHtmlPlan,
  listHtmlPlans,
  renameHtmlPlan,
  remapHtmlPlans,
  sanitizeHtmlPlan,
  saveHtmlPlan,
} = require("../dist/html-plan-store");
const {
  appendHistory,
  getHistory,
  removeHtmlPlanHistoryEntries,
  updateHtmlPlanHistoryEntry,
} = require("../dist/session-store");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("stores, updates, renames, and deletes plans within one session", () => {
  const created = saveHtmlPlan({
    sessionId: "plan-session",
    title: "Launch plan",
    html: "<h1>Launch</h1><p>First version</p>",
  });
  assert.equal(listHtmlPlans("plan-session").length, 1);

  const updated = saveHtmlPlan({
    sessionId: "plan-session",
    planId: created.planId,
    title: "Launch plan",
    html: "<h1>Launch</h1><p>Revised version</p>",
  });
  assert.equal(updated.createdAt, created.createdAt);
  assert.match(updated.html, /Revised version/);
  assert.equal(listHtmlPlans("plan-session").length, 1);

  const renamed = renameHtmlPlan("plan-session", created.planId, "Release plan");
  assert.equal(renamed.title, "Release plan");
  assert.equal(deleteHtmlPlan("plan-session", created.planId), true);
  assert.deepEqual(listHtmlPlans("plan-session"), []);
});

test("removes executable and remote content while retaining formatting", () => {
  const sanitized = sanitizeHtmlPlan(`
    <style>.card { color: red; background: url(https://bad.example/a.png) }</style>
    <script>alert(1)</script>
    <h2 onclick="alert(2)">Safe heading</h2>
    <img src="https://bad.example/image.png">
    <img src="data:image/png;base64,AAAA">
  `);
  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /onclick/i);
  assert.doesNotMatch(sanitized, /bad\.example/i);
  assert.match(sanitized, /Safe heading/);
  assert.match(sanitized, /data:image\/png;base64,AAAA/);
});

test("deleting a plan removes its durable chat artifact history", () => {
  appendHistory("history-plan-session", {
    role: "html_plan",
    content: "Plan",
    toolInput: { planId: "plan-1", title: "Plan", html: "<p>body</p>" },
    timestamp: new Date().toISOString(),
  });
  appendHistory("history-plan-session", {
    role: "assistant",
    content: "Other transcript content",
    timestamp: new Date().toISOString(),
  });
  removeHtmlPlanHistoryEntries("history-plan-session", "plan-1");
  const history = getHistory("history-plan-session");
  assert.equal(history.some((entry) => entry.role === "html_plan"), false);
  assert.equal(history.some((entry) => entry.content === "Other transcript content"), true);
});

test("renaming a plan updates its durable chat card", () => {
  appendHistory("rename-plan-session", {
    role: "html_plan",
    content: "Old title",
    toolInput: { planId: "plan-rename", title: "Old title", html: "<p>body</p>" },
    timestamp: "2026-07-17T00:00:00.000Z",
  });
  updateHtmlPlanHistoryEntry("rename-plan-session", {
    planId: "plan-rename",
    title: "New title",
    html: "<p>body</p>",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T01:00:00.000Z",
  });
  const [entry] = getHistory("rename-plan-session");
  assert.equal(entry.content, "New title");
  assert.equal(entry.toolInput.title, "New title");
  assert.equal(entry.timestamp, "2026-07-17T01:00:00.000Z");
});

test("plans follow a session ID remap", () => {
  const saved = saveHtmlPlan({
    sessionId: "old-session-id",
    title: "Persistent plan",
    html: "<p>Keep me</p>",
  });
  remapHtmlPlans("old-session-id", "new-session-id");
  assert.deepEqual(listHtmlPlans("old-session-id"), []);
  const [moved] = listHtmlPlans("new-session-id");
  assert.equal(moved.planId, saved.planId);
  assert.equal(moved.sessionId, "new-session-id");
});
