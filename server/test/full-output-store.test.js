const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-full-output-test-"));
process.env.SOCKETAGENT_DATA_DIR = dataDir;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { saveFullOutput, readFullOutput, trimOldFullOutputs, decodeCapture } = require("#server/full-output-store");

const DAY = 24 * 60 * 60 * 1000;

/** @param {string} text */
function capture(text) {
  const file = path.join(dataDir, `capture-${Math.random()}.log`);
  fs.writeFileSync(file, text);
  return file;
}

test("keeps the full output only when the agent saw less", () => {
  const full = [...Array(50).keys()].map((i) => `line ${i}`).join("\n");
  assert.equal(saveFullOutput("s1", "t1", capture(full), "line 49"), Buffer.byteLength(full));
  assert.equal(readFullOutput("s1", "t1"), full);
  assert.equal(saveFullOutput("s1", "t2", capture("same\n"), "same"), null);
  assert.equal(readFullOutput("s1", "t2"), null);
  assert.equal(saveFullOutput("s1", "t3", path.join(dataDir, "missing.log"), ""), null);
});

test("reads PowerShell's UTF-16 captures", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("8\r\n9\r\n", "utf16le")]);
  assert.equal(decodeCapture(utf16), "8\r\n9\r\n");
});

test("trims outputs older than a day to their ends, once", async () => {
  const full = `${"a".repeat(5000)}${"b".repeat(20000)}${"c".repeat(9000)}`;
  saveFullOutput("s2", "old", capture(full), "");
  saveFullOutput("s2", "new", capture(full), "");
  const oldFile = path.join(dataDir, "tool-output", "s2", "full-old.txt");
  const twoDaysAgo = new Date(Date.now() - 2 * DAY);
  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

  assert.equal(await trimOldFullOutputs(), 1);
  const trimmed = readFullOutput("s2", "old");
  assert.ok(trimmed.startsWith("a".repeat(2048)));
  assert.ok(trimmed.endsWith("c".repeat(8192)));
  assert.match(trimmed, /\[\d+ KB trimmed after a day\]/);
  assert.ok(trimmed.length < 10_500);
  assert.equal(readFullOutput("s2", "new"), full);

  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);
  assert.equal(await trimOldFullOutputs(), 0);
  assert.equal(readFullOutput("s2", "old"), trimmed);
});
