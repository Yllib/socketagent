const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-send-file-test-"));
process.env.SOCKETAGENT_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { pruneSendFiles } = require("#server/send-file-store");

const DAY = 24 * 60 * 60 * 1000;

test("removes sent files older than the retention and keeps the rest", async () => {
  const root = path.join(dataDir, "send-files");
  for (const name of ["send_old", "send_new"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "f.txt"), "x");
  }
  const old = new Date(Date.now() - 31 * DAY);
  fs.utimesSync(path.join(root, "send_old"), old, old);

  assert.equal(await pruneSendFiles(0), 0);
  assert.equal(await pruneSendFiles(30), 1);
  assert.deepEqual(fs.readdirSync(root), ["send_new"]);
});
