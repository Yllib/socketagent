const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { runPeerCommand, clampPeerCommandTimeout, PEER_COMMAND_OUTPUT_CAP } = require("#server/peer-command");

const posix = process.platform !== "win32";

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("timeouts default to 120 s and cap at 600 s", () => {
  assert.equal(clampPeerCommandTimeout(undefined), 120);
  assert.equal(clampPeerCommandTimeout(0), 120);
  assert.equal(clampPeerCommandTimeout(5000), 600);
  assert.equal(clampPeerCommandTimeout(0.2), 1);
});

test("run_command returns output, exit code and the caps", { skip: !posix }, async () => {
  const result = await runPeerCommand({ command: "echo out; echo err >&2; exit 3", cwd: dataDir, timeoutSeconds: 10 });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);

  const big = await runPeerCommand({ command: "head -c 200000 /dev/zero | tr '\\0' x", cwd: dataDir, timeoutSeconds: 10 });
  assert.equal(big.stdout.length, PEER_COMMAND_OUTPUT_CAP);
  assert.equal(big.truncated, true);
});

test("run_command timeout kills the whole process tree", { skip: !posix }, async () => {
  const pidFile = path.join(dataDir, "peer-command-pids");
  // A background child and a foreground child, both of which would outlive
  // the shell if only the shell were killed.
  const command = `sleep 30 & echo $! > ${pidFile}; echo $$ >> ${pidFile}; sleep 30`;
  const started = Date.now();
  const result = await runPeerCommand({ command, cwd: dataDir, timeoutSeconds: 1 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000, "timeout should fire promptly");
  const [background, shell] = fs.readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  assert.ok(background > 0 && shell > 0);
  // Give the kernel a moment to reap.
  for (let attempt = 0; attempt < 40 && (alive(background) || alive(shell)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive(background), false, "background sleep should be dead");
  assert.equal(alive(shell), false, "shell should be dead");
});
