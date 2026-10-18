const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { isNativeSessionTranscript, watchNativeSessionFolders } = require("#server/native-session-watcher");

test("recognizes session transcripts but not subagent or other files", () => {
  assert.equal(isNativeSessionTranscript("codex", "2026/10/17/rollout-2026-10-17T19-11-05-abc.jsonl"), true);
  assert.equal(isNativeSessionTranscript("codex", "2026/10/17/notes.jsonl"), false);
  assert.equal(isNativeSessionTranscript("claude", "-home-me-project/0b1c.jsonl"), true);
  assert.equal(isNativeSessionTranscript("claude", "-home-me-project/0b1c/subagents/agent-a1.jsonl"), false);
  assert.equal(isNativeSessionTranscript("claude", "-home-me-project/memory/notes.md"), false);
});

test("reports a new transcript once and ignores appends to it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-native-watch-"));
  const codex = path.join(root, "sessions");
  const claude = path.join(root, "projects");
  fs.mkdirSync(path.join(codex, "2026", "10", "17"), { recursive: true });
  fs.mkdirSync(claude);
  let calls = 0;
  const stop = watchNativeSessionFolders(() => { calls += 1; }, { codex, claude }, 100);
  t.after(() => {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** @returns {Promise<void>} */
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 400); });

  const rollout = path.join(codex, "2026", "10", "17", "rollout-test.jsonl");
  fs.writeFileSync(rollout, "{}\n");
  fs.appendFileSync(rollout, "{}\n");
  await settle();
  assert.equal(calls, 1);

  fs.appendFileSync(rollout, "{}\n");
  await settle();
  assert.equal(calls, 1);
});

test("reports a transcript in a folder created after watching began", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-native-watch-"));
  const codex = path.join(root, "sessions");
  const claude = path.join(root, "projects");
  fs.mkdirSync(codex);
  fs.mkdirSync(claude);
  let calls = 0;
  const stop = watchNativeSessionFolders(() => { calls += 1; }, { codex, claude }, 100);
  t.after(() => {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** @returns {Promise<void>} */
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 400); });

  const day = path.join(codex, "2026", "10", "18");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-new.jsonl"), "{}\n");
  await settle();
  assert.equal(calls, 1);

  fs.mkdirSync(path.join(claude, "-home-me-new"));
  await settle();
  fs.writeFileSync(path.join(claude, "-home-me-new", "abc.jsonl"), "{}\n");
  await settle();
  assert.equal(calls, 2);
});
