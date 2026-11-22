const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-delete-"));
process.env.SOCKET_AGENT_DATA_DIR = dataDir;

const { appendHistory, deleteSessionArtifacts, getHistory } = require("#server/session-store");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/**
 * Writes an inline image snapshot the way InlineImageStore does, made by [sessionId].
 * @param {string} sessionId
 */
function image(sessionId) {
  const id = crypto.randomUUID();
  const dir = path.join(dataDir, "inline-images", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "image"), "png");
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ id, sessionId }));
  return id;
}

const shown = (/** @type {string} */ id) => `![shot](socketagent://image?id=${id}&name=image.png)`;
const imageExists = (/** @type {string} */ id) => fs.existsSync(path.join(dataDir, "inline-images", id));

test("deleting a session deletes its archived copies and its images, but not a branch's", () => {
  const archive = path.join(dataDir, "archive");
  fs.mkdirSync(archive, { recursive: true });
  const info = { id: "chat-now", cwd: "/work", createdAt: "2026-11-01T10:00:00.000Z", title: "Chat", lastActive: "2026-11-01T10:00:00.000Z" };
  // A clear filed the old transcript under the ID the chat had before.
  const ts = "2026-11-02T10-00-00-000Z";
  fs.writeFileSync(path.join(archive, `chat-before_${ts}_history.json`), JSON.stringify([{ role: "user", content: "old secret plans" }]));
  fs.writeFileSync(path.join(archive, `chat-before_${ts}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(archive, `chat-before_${ts}_meta.json`), JSON.stringify({ sid: "chat-before", cwd: "/work", createdAt: info.createdAt }));
  // A rewind snapshot under the current ID, and another chat's archive.
  fs.writeFileSync(path.join(archive, `chat-now_2026-11-03T10-00-00-000Z_history.json`), "[]");
  fs.writeFileSync(path.join(archive, `other_${ts}_history.json`), "[]");
  fs.writeFileSync(path.join(archive, `other_${ts}_meta.json`), JSON.stringify({ sid: "other", cwd: "/work", createdAt: "2026-10-01T10:00:00.000Z" }));

  const [own, old, branched, others] = [image("chat-now"), image("chat-before"), image("chat-now"), image("other")];
  appendHistory("chat-now", { role: "assistant", content: `${shown(own)} ${shown(branched)}`, timestamp: info.createdAt });
  appendHistory("branch", { role: "assistant", content: shown(branched), timestamp: info.createdAt });

  deleteSessionArtifacts("chat-now", info);

  assert.deepEqual(fs.readdirSync(archive).sort(), [`other_${ts}_history.json`, `other_${ts}_meta.json`]);
  assert.equal(imageExists(own), false);
  assert.equal(imageExists(old), false);
  assert.equal(imageExists(branched), true, "the branch still shows it");
  assert.equal(imageExists(others), true);
  assert.equal(getHistory("branch").length, 1);
});
