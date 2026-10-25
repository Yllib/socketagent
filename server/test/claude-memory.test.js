const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-claude-memory-"));
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.SOCKET_AGENT_DATA_DIR = path.join(root, "data");

const {
  ClaudeMemoryWatcher,
  claudeMemoryDir,
  claudeProjectSlug,
  deleteMemoryFile,
  memoryIndexWithout,
  parseMemoryFile,
  readMemoryFile,
  resolveMemoryFilePath,
  writeMemoryFile,
} = require("#server/claude-memory");
const { appendHistory, getHistory, updateMemoryCards } = require("#server/session-store");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const cwd = "/home/someone/agents/project.one";
const memoryDir = claudeMemoryDir(cwd);

/**
 * @param {string} name
 * @param {string} description
 * @param {string} type
 * @param {string} body
 */
function memoryText(name, description, type, body) {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

function freshMemoryDir() {
  fs.rmSync(memoryDir, { recursive: true, force: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "- [Keep me](keep-me.md) — stays\n");
  fs.writeFileSync(path.join(memoryDir, "keep-me.md"), memoryText("keep-me", "Already there", "project", "Old body."));
}

test("the memory folder follows Claude Code's project slug", () => {
  assert.equal(claudeProjectSlug(cwd), "-home-someone-agents-project-one");
  assert.equal(memoryDir, path.join(root, "claude", "projects", "-home-someone-agents-project-one", "memory"));
});

test("frontmatter fields and the body are split out, with a fallback name", () => {
  const parsed = parseMemoryFile("flutter-sdk-path.md", memoryText("flutter-sdk-path", "flutter is at ~/flutter/bin", "reference", "Body line.\n\n**Why:** because."));
  assert.deepEqual(parsed, {
    name: "flutter-sdk-path",
    description: "flutter is at ~/flutter/bin",
    memoryType: "reference",
    body: "Body line.\n\n**Why:** because.",
  });
  assert.deepEqual(parseMemoryFile("plain-note.md", "Just a body\n"), {
    name: "plain-note", description: "", memoryType: "", body: "Just a body",
  });
});

test("a tool call that creates, edits, appends with a shell, or deletes a memory yields one card each", () => {
  freshMemoryDir();
  const watcher = new ClaudeMemoryWatcher(memoryDir);
  watcher.prime();
  assert.deepEqual(watcher.collect(), [], "nothing changed yet");

  // Write tool: a new memory plus its index line.
  fs.writeFileSync(path.join(memoryDir, "new-rule.md"), memoryText("new-rule", "Push only on request", "feedback", "Pushing deploys everywhere."));
  fs.appendFileSync(path.join(memoryDir, "MEMORY.md"), "- [New rule](new-rule.md) — push only on request\n");
  const created = watcher.collect();
  assert.equal(created.length, 1, "MEMORY.md upkeep gets no card of its own");
  assert.deepEqual(created[0], {
    path: path.join(memoryDir, "new-rule.md"),
    name: "new-rule",
    description: "Push only on request",
    memoryType: "feedback",
    body: "Pushing deploys everywhere.",
    change: "created",
  });

  // Edit tool.
  fs.writeFileSync(path.join(memoryDir, "keep-me.md"), memoryText("keep-me", "Already there", "project", "New body."));
  const edited = watcher.collect();
  assert.equal(edited.length, 1);
  assert.equal(edited[0].change, "edited");
  assert.equal(edited[0].body, "New body.");

  // Bash append.
  execFileSync("sh", ["-c", `echo "Appended line." >> "${path.join(memoryDir, "keep-me.md")}"`]);
  const appended = watcher.collect();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].change, "edited");
  assert.match(appended[0].body, /New body\.\nAppended line\.$/);

  // Delete.
  fs.unlinkSync(path.join(memoryDir, "new-rule.md"));
  const deleted = watcher.collect();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].change, "deleted");
  assert.equal(deleted[0].name, "new-rule");
  assert.equal(deleted[0].body, "Pushing deploys everywhere.", "a deleted card keeps the last body");

  // Index-only edit.
  fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "- [Keep me](keep-me.md) — stays\n");
  assert.deepEqual(watcher.collect(), []);

  // A symlinked file in the folder is not a memory.
  fs.symlinkSync(path.join(root, "outside.md"), path.join(memoryDir, "linked.md"));
  assert.deepEqual(watcher.collect(), []);
});

test("a watcher that never primed reports nothing for the first look", () => {
  freshMemoryDir();
  const watcher = new ClaudeMemoryWatcher(memoryDir);
  fs.writeFileSync(path.join(memoryDir, "late.md"), "body");
  assert.deepEqual(watcher.collect(), []);
  fs.writeFileSync(path.join(memoryDir, "late.md"), "body two");
  assert.equal(watcher.collect()[0].change, "edited");
});

test("only memory files under a project's memory folder pass the path check", () => {
  freshMemoryDir();
  const good = path.join(memoryDir, "keep-me.md");
  assert.equal(resolveMemoryFilePath(good), good);
  assert.equal(resolveMemoryFilePath(path.join(memoryDir, "..", "memory", "keep-me.md")), good);
  assert.equal(resolveMemoryFilePath(path.join(memoryDir, "brand-new.md")), path.join(memoryDir, "brand-new.md"), "a new file in the folder is fine");

  const projectsRoot = path.join(root, "claude", "projects");
  for (const bad of [
    "",
    "keep-me.md",
    path.join(memoryDir, "MEMORY.md"),
    path.join(memoryDir, "notes.txt"),
    path.join(memoryDir, "..", "keep-me.md"),
    path.join(memoryDir, "..", "..", "..", "settings.json"),
    path.join(memoryDir, "nested", "deep.md"),
    path.join(projectsRoot, "memory", "x.md"),
    path.join(projectsRoot, "..", "projects", "slug", "memory", "..", "..", "..", "..", "etc", "passwd"),
    path.join(root, "outside.md"),
  ]) {
    assert.throws(() => resolveMemoryFilePath(bad), `accepted ${JSON.stringify(bad)}`);
  }
});

test("symlinks cannot carry a memory action outside the projects root", () => {
  freshMemoryDir();
  const outside = path.join(root, "elsewhere");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");

  // A file that is a link.
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(memoryDir, "link.md"));
  assert.throws(() => resolveMemoryFilePath(path.join(memoryDir, "link.md")), /regular memory file/);

  // A memory folder that is a link.
  const linkedProject = path.join(root, "claude", "projects", "-linked-project");
  fs.mkdirSync(linkedProject, { recursive: true });
  fs.symlinkSync(outside, path.join(linkedProject, "memory"));
  assert.throws(() => resolveMemoryFilePath(path.join(linkedProject, "memory", "secret.md")), /link outside/);

  // A project folder that is a link.
  fs.symlinkSync(outside, path.join(root, "claude", "projects", "-linked-slug"));
  fs.mkdirSync(path.join(outside, "memory"), { recursive: true });
  fs.writeFileSync(path.join(outside, "memory", "far.md"), "far");
  assert.throws(() => resolveMemoryFilePath(path.join(root, "claude", "projects", "-linked-slug", "memory", "far.md")), /link outside/);
});

test("reading and writing go through the same path check", () => {
  freshMemoryDir();
  const file = path.join(memoryDir, "keep-me.md");
  assert.equal(readMemoryFile(file).content, memoryText("keep-me", "Already there", "project", "Old body."));
  const saved = writeMemoryFile(file, memoryText("keep-me", "Changed by hand", "feedback", "Hand edited."));
  assert.equal(saved.card.description, "Changed by hand");
  assert.equal(saved.card.memoryType, "feedback");
  assert.equal(saved.card.body, "Hand edited.");
  assert.equal(fs.readFileSync(file, "utf8"), memoryText("keep-me", "Changed by hand", "feedback", "Hand edited."));
  assert.throws(() => writeMemoryFile(path.join(memoryDir, "MEMORY.md"), "x"));
  assert.throws(() => readMemoryFile(path.join(root, "outside.md")));
});

test("deleting a memory drops its index line and nothing else", () => {
  freshMemoryDir();
  fs.writeFileSync(path.join(memoryDir, "other.md"), "other");
  fs.writeFileSync(
    path.join(memoryDir, "MEMORY.md"),
    "# Memories\n- [Keep me](keep-me.md) — stays\n- [Other](./other.md) — also stays\n- [Keep me again](keep-me.md) — duplicate line goes too\n",
  );
  const result = deleteMemoryFile(path.join(memoryDir, "keep-me.md"));
  assert.equal(result.indexUpdated, true);
  assert.equal(fs.existsSync(path.join(memoryDir, "keep-me.md")), false);
  assert.equal(
    fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8"),
    "# Memories\n- [Other](./other.md) — also stays\n",
  );
  assert.throws(() => deleteMemoryFile(path.join(memoryDir, "keep-me.md")), /already gone/);

  // No index file is fine.
  fs.unlinkSync(path.join(memoryDir, "MEMORY.md"));
  assert.deepEqual(deleteMemoryFile(path.join(memoryDir, "other.md")), { path: path.join(memoryDir, "other.md"), indexUpdated: false });
});

test("memoryIndexWithout matches the link target, not the label", () => {
  const index = "- [keep-me](flutter-sdk-path.md) — about flutter\n- [Flutter](keep-me.md) — about keep-me\n";
  assert.equal(memoryIndexWithout(index, "keep-me.md"), "- [keep-me](flutter-sdk-path.md) — about flutter\n");
});

test("a card action rewrites every card for that file in the chat and bumps their revisions", () => {
  const sessionId = "memory-card-session";
  const memoryPath = path.join(memoryDir, "keep-me.md");
  const card = { path: memoryPath, name: "keep-me", description: "Already there", memoryType: "project", body: "Old body.", change: "created" };
  appendHistory(sessionId, { role: "memory", content: "Saved memory: keep-me", questionId: "memory_1", memory: card, timestamp: new Date().toISOString() });
  appendHistory(sessionId, { role: "memory", content: "Updated memory: keep-me", questionId: "memory_2", memory: { ...card, change: "edited", body: "Second body." }, timestamp: new Date().toISOString() });
  appendHistory(sessionId, { role: "memory", content: "Saved memory: other", questionId: "memory_3", memory: { ...card, path: path.join(memoryDir, "other.md"), name: "other" }, timestamp: new Date().toISOString() });

  const changed = updateMemoryCards(sessionId, memoryPath, (memory) => ({ ...memory, userChange: "deleted" }));
  assert.equal(changed.length, 2);
  assert.ok(changed.every((entry) => entry.revision === 2 && entry.memory.userChange === "deleted"));

  const stored = getHistory(sessionId).filter((entry) => entry.role === "memory");
  assert.equal(stored.length, 3, "updates replace entries instead of appending");
  assert.deepEqual(stored.map((entry) => entry.memory.userChange), ["deleted", "deleted", undefined]);
  assert.equal(stored[1].memory.body, "Second body.", "each card keeps its own body");

  assert.deepEqual(updateMemoryCards(sessionId, memoryPath, (memory) => memory), [], "no change, no rewrite");
});
