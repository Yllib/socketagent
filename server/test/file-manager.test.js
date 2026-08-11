const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  listFileManagerDirectory,
  readDirectoryEntries,
  statFileManagerPath,
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

test("direct stat inspects one file without listing its parent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-stat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "preview.html");
  fs.writeFileSync(filePath, "<h1>Preview</h1>");
  for (let index = 0; index < 1000; index += 1) {
    fs.writeFileSync(path.join(root, `noise-${index}.txt`), "x");
  }

  const entry = await statFileManagerPath({ filePath, defaultCwd: root });

  assert.equal(entry.path, filePath);
  assert.equal(entry.name, "preview.html");
  assert.equal(entry.kind, "file");
  assert.equal(entry.mediaKind, "code");
});

test("paginated directory listings stat and return only the requested page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 25; index += 1) {
    fs.writeFileSync(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "x");
  }

  const first = await listFileManagerDirectory({
    defaultCwd: root,
    offset: 0,
    limit: 10,
  });
  const last = await listFileManagerDirectory({
    defaultCwd: root,
    offset: first.nextOffset,
    limit: 20,
  });

  assert.equal(first.entries.length, 10);
  assert.equal(first.totalCount, 25);
  assert.equal(first.nextOffset, 10);
  assert.equal(first.hasMore, true);
  assert.equal(last.entries.length, 15);
  assert.equal(last.offset, 10);
  assert.equal(last.hasMore, false);
});

test("anchored pagination returns the page containing the requested child", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-anchor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 30; index += 1) {
    fs.writeFileSync(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "x");
  }
  const anchorPath = path.join(root, "file-23.txt");

  const listing = await listFileManagerDirectory({
    defaultCwd: root,
    limit: 10,
    anchorPath,
  });

  assert.equal(listing.offset, 20);
  assert.equal(listing.entries.some((entry) => entry.path === anchorPath), true);
});

test("legacy clients receive an error instead of an oversized directory payload", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-legacy-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 2001; index += 1) {
    fs.writeFileSync(path.join(root, `file-${index}.txt`), "x");
  }

  await assert.rejects(
    listFileManagerDirectory({ defaultCwd: root }),
    /paginated listing is required/,
  );
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
