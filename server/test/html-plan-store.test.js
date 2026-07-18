const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-html-plans-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const {
  deleteHtmlPlan,
  diffHtmlPlanRevisions,
  getHtmlPlanRevision,
  listHtmlPlanRevisions,
  listHtmlPlans,
  renameHtmlPlan,
  remapHtmlPlans,
  sanitizeHtmlPlan,
  saveHtmlPlan,
  rollbackHtmlPlan,
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
  assert.equal(created.currentRevision, 1);
  assert.equal(created.revisionCount, 1);

  const updated = saveHtmlPlan({
    sessionId: "plan-session",
    planId: created.planId,
    title: "Launch plan",
    html: "<h1>Launch</h1><p>Revised version</p>",
  });
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.currentRevision, 2);
  assert.equal(updated.revisionCount, 2);
  assert.match(updated.html, /Revised version/);
  assert.equal(listHtmlPlans("plan-session").length, 1);

  const renamed = renameHtmlPlan("plan-session", created.planId, "Release plan");
  assert.equal(renamed.title, "Release plan");
  assert.equal(deleteHtmlPlan("plan-session", created.planId), true);
  assert.deepEqual(listHtmlPlans("plan-session"), []);
});

test("retains revisions, generates diffs, and rolls back by appending a revision", () => {
  const first = saveHtmlPlan({
    sessionId: "revision-session",
    title: "Deploy plan",
    html: "<h1>Deploy</h1><p>Ship alpha today</p>",
  });
  const second = saveHtmlPlan({
    sessionId: "revision-session",
    planId: first.planId,
    title: "Deploy plan",
    html: "<h1>Deploy</h1><p>Ship beta tomorrow</p>",
  });

  const revisions = listHtmlPlanRevisions("revision-session", first.planId);
  assert.deepEqual(revisions.map((revision) => revision.revision), [2, 1]);
  assert.match(getHtmlPlanRevision("revision-session", first.planId, 1).html, /alpha today/);
  const diff = diffHtmlPlanRevisions("revision-session", first.planId, 2);
  assert.equal(diff.baseRevision, 1);
  assert.match(diff.segments.filter((segment) => segment.type === "removed").map((segment) => segment.text).join(""), /alpha|today/);
  assert.match(diff.segments.filter((segment) => segment.type === "added").map((segment) => segment.text).join(""), /beta|tomorrow/);

  const restored = rollbackHtmlPlan("revision-session", first.planId, 1);
  assert.equal(restored.currentRevision, 3);
  assert.equal(restored.revisionCount, 3);
  assert.match(restored.html, /alpha today/);
  const restoredSummary = listHtmlPlanRevisions("revision-session", first.planId)[0];
  assert.equal(restoredSummary.restoredFromRevision, 1);

  const duplicate = saveHtmlPlan({
    sessionId: "revision-session",
    planId: first.planId,
    title: restored.title,
    html: restored.html,
  });
  assert.equal(duplicate.currentRevision, 3);
  assert.equal(second.currentRevision, 2);
});

test("migrates legacy single-version plan files into revision one", () => {
  const legacyDir = path.join(dataDir, "html-plans");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "legacy-session.json"), JSON.stringify([{
    planId: "legacy-plan",
    sessionId: "legacy-session",
    title: "Legacy",
    html: "<p>Preserved</p>",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T01:00:00.000Z",
  }]));

  const [plan] = listHtmlPlans("legacy-session");
  assert.equal(plan.currentRevision, 1);
  assert.equal(plan.revisionCount, 1);
  assert.match(getHtmlPlanRevision("legacy-session", "legacy-plan", 1).html, /Preserved/);
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
