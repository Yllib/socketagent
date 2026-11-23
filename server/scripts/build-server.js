#!/usr/bin/env node
// Compiles the server before it starts, without ever breaking the last good
// build. Both service wrappers (start-server.sh and the Windows
// run-service.bat) run this before launching dist/index.js.
//
// The compile goes into dist.next with noEmitOnError and replaces dist only
// when it is clean. A failed compile leaves dist running and writes
// dist/.build-failure.json, which the server reports to the sessions it
// resumes. The same broken source is not recompiled on every start.
//
// Exits 0 when dist is runnable (fresh or previous), 1 only when none exists.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const serverDir = path.resolve(__dirname, "..");
const dist = path.join(serverDir, "dist");
const next = path.join(serverDir, "dist.next");
const previous = path.join(serverDir, "dist.prev");
const entry = path.join(dist, "index.js");
const failureFile = path.join(dist, ".build-failure.json");

/** @param {string} message */
function log(message) {
  console.log(`[build] ${message}`);
}

/** Newest modification time across the inputs that change the output. */
function newestSource() {
  let newest = 0;
  /** @param {string} dir */
  const visit = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.name.endsWith(".ts")) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  visit(path.join(serverDir, "src"));
  newest = Math.max(newest, fs.statSync(path.join(serverDir, "tsconfig.json")).mtimeMs);
  // npm rewrites this on every install, so new dependencies retry a compile
  // that failed against the old ones.
  try {
    newest = Math.max(newest, fs.statSync(path.join(serverDir, "node_modules", ".package-lock.json")).mtimeMs);
  } catch {
    // No install yet; the compiler check below reports it.
  }
  return newest;
}

/** @returns {number | undefined} The source time of the last failed build. */
function failedSource() {
  try {
    /** @type {unknown} */
    const data = JSON.parse(fs.readFileSync(failureFile, "utf8"));
    if (data && typeof data === "object" && "source" in data && typeof data.source === "number") return data.source;
  } catch {
    // No record, or an unreadable one: compile again.
  }
  return undefined;
}

/**
 * Windows can briefly lock a folder that a scanner or indexer is reading.
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * attempt);
    }
  }
}

const hasBuild = fs.existsSync(entry);
const source = newestSource();
if (hasBuild && source <= fs.statSync(entry).mtimeMs) process.exit(0);
if (hasBuild && failedSource() === source) {
  log("Source is unchanged since its last failed build. Running the previous build.");
  process.exit(0);
}

const tsc = path.join(serverDir, "node_modules", "typescript", "bin", "tsc");
// A broken node_modules is not a source failure, so nothing is recorded and
// the compile runs again once npm ci restores it.
if (!fs.existsSync(tsc)) {
  log(`TypeScript is not installed. Run npm ci in ${serverDir}.`);
  if (hasBuild) log("Running the previous build.");
  process.exit(hasBuild ? 0 : 1);
}

log("Compiling the server");
fs.rmSync(next, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [tsc, "-p", path.join(serverDir, "tsconfig.json"), "--outDir", next, "--noEmitOnError"],
  { cwd: serverDir, encoding: "utf8" },
);
const output = `${result.stdout || ""}${result.stderr || ""}${result.error ? String(result.error) : ""}`.trim();

if (result.status === 0 && fs.existsSync(path.join(next, "index.js"))) {
  fs.rmSync(previous, { recursive: true, force: true });
  if (hasBuild || fs.existsSync(dist)) renameWithRetry(dist, previous);
  try {
    renameWithRetry(next, dist);
  } catch (error) {
    if (fs.existsSync(previous)) renameWithRetry(previous, dist);
    throw error;
  }
  fs.rmSync(previous, { recursive: true, force: true });
  log("Compiled");
  process.exit(0);
}

fs.rmSync(next, { recursive: true, force: true });
console.error(output);
if (!hasBuild) {
  log("Compile failed and there is no previous build to run.");
  process.exit(1);
}
fs.writeFileSync(failureFile, JSON.stringify({
  failedAt: new Date().toISOString(),
  source,
  output: output.slice(-6000),
}, null, 2));
log("Compile failed. Running the previous build.");
process.exit(0);
