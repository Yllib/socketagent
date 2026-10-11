const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildFailureNote } = require("#server/restart-recovery");

const serverDir = path.resolve(__dirname, "..");

/**
 * A minimal server checkout: the real build script, one source file, and the real compiler.
 * @param {import("node:test").TestContext} t
 */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.copyFileSync(path.join(serverDir, "scripts", "build-server.js"), path.join(dir, "scripts", "build-server.js"));
  fs.symlinkSync(path.join(serverDir, "node_modules"), path.join(dir, "node_modules"), "junction");
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "commonjs", outDir: "./dist", rootDir: "./src", strict: true },
    include: ["src/**/*"],
  }));
  let clock = Date.now() / 1000;
  /**
   * Writes the source with a modification time after every earlier write.
   * @param {string} code
   */
  const write = (code) => {
    const file = path.join(dir, "src", "index.ts");
    fs.writeFileSync(file, code);
    clock += 10;
    fs.utimesSync(file, clock, clock);
  };
  const build = () => spawnSync(process.execPath, [path.join(dir, "scripts", "build-server.js")], { encoding: "utf8" });
  const output = () => fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8");
  return { dir, write, build, output, failure: path.join(dir, "dist", ".build-failure.json") };
}

test("a broken compile keeps the last good build and is reported once", t => {
  const { write, build, output, failure } = fixture(t);
  write("export const version: number = 1;\n");
  assert.equal(build().status, 0);
  assert.match(output(), /version = 1/);

  write("export const version: number = \"two\";\n");
  const broken = build();
  assert.equal(broken.status, 0, "the previous build still runs");
  assert.match(output(), /version = 1/);
  assert.match(buildFailureNote(failure), /previous build is running[\s\S]*TS2322/);

  assert.match(build().stdout, /unchanged since its last failed build/);

  write("export const version: number = 3;\n");
  assert.equal(build().status, 0);
  assert.match(output(), /version = 3/);
  assert.equal(buildFailureNote(failure), undefined);
});

test("a broken compile with no previous build fails the start", t => {
  const { write, build } = fixture(t);
  write("export const version: number = \"one\";\n");
  assert.equal(build().status, 1);
});
