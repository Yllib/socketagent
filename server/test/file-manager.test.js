const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  listFileManagerDirectory,
  readDirectoryEntries,
  writeFileManagerText,
} = require("../dist/file-manager.js");

test("directory listing is asynchronous and includes visible entries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "folder"));
  fs.writeFileSync(path.join(root, "notes.txt"), "hello");
  fs.writeFileSync(path.join(root, ".hidden"), "secret");

  const rawEntries = await readDirectoryEntries(root);
  assert.equal(rawEntries.some((entry) => entry.name === "folder"), true);

  const listingPromise = listFileManagerDirectory({ defaultCwd: root });
  assert.equal(typeof listingPromise.then, "function");
  const listing = await listingPromise;

  assert.equal(listing.path, root);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["folder", "notes.txt"]);
});

test("text writes create and replace a file inside an allowed root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "AGENTS.md");

  const created = writeFileManagerText({
    filePath,
    content: "# First\n",
    defaultCwd: root,
  });
  assert.equal(created.path, filePath);
  assert.equal(fs.readFileSync(filePath, "utf8"), "# First\n");

  writeFileManagerText({
    filePath,
    content: "# Replaced\n",
    defaultCwd: root,
  });
  assert.equal(fs.readFileSync(filePath, "utf8"), "# Replaced\n");
});

test("text writes enforce their byte limit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      writeFileManagerText({
        filePath: path.join(root, "CLAUDE.md"),
        content: "too large",
        defaultCwd: root,
        maxBytes: 4,
      }),
    /limited to 4 bytes/,
  );
});
