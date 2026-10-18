const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const {
  bashCapturePath,
  wrapBashForCapture,
  pruneBashCaptures,
} = require("#server/bash-capture");

const DAY = 24 * 60 * 60 * 1000;

test("the wrapped command keeps its output and exit status and fills the capture", () => {
  const id = `toolu_test_${process.pid}`;
  const wrapped = wrapBashForCapture("echo out; echo err >&2; exit 3", id);
  const run = spawnSync("bash", ["-c", wrapped], { encoding: "utf8" });
  try {
    assert.equal(run.status, 3);
    assert.equal(run.stdout, "out\nerr\n");
    assert.equal(fs.readFileSync(bashCapturePath(id), "utf8"), "out\nerr\n");
  } finally {
    fs.rmSync(bashCapturePath(id), { force: true });
  }
});

test("tool ids cannot escape the capture folder", () => {
  assert.equal(bashCapturePath("../../etc/x'y").endsWith("______etc_x_y.log"), true);
});

test("pruning removes day-old captures and keeps fresh ones", async () => {
  const oldFile = bashCapturePath(`toolu_old_${process.pid}`);
  const freshFile = bashCapturePath(`toolu_fresh_${process.pid}`);
  wrapBashForCapture("true", `toolu_old_${process.pid}`);
  wrapBashForCapture("true", `toolu_fresh_${process.pid}`);
  const twoDaysAgo = new Date(Date.now() - 2 * DAY);
  fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);
  try {
    await pruneBashCaptures();
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
  } finally {
    fs.rmSync(oldFile, { force: true });
    fs.rmSync(freshFile, { force: true });
  }
});
