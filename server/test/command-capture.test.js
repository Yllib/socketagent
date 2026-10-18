const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  insertShellTee,
  insertPowerShellTee,
  shellTeeStage,
  powerShellTeeStage,
  stripCaptureStages,
} = require("#server/command-capture");

const CAP = "/tmp/socketagent-bash/t.log";
const T = shellTeeStage(CAP);

test("shell: tee goes before the first filter of each pipeline", () => {
  assert.equal(insertShellTee("npm test | tail -20", CAP), `npm test |${T} tail -20`);
  assert.equal(insertShellTee("make 2>&1 | grep -v warn | head -5", CAP), `make 2>&1 |${T} grep -v warn | head -5`);
  assert.equal(insertShellTee("cd x && npm test | tail; ls | wc -l", CAP), `cd x && npm test |${T} tail; ls |${T} wc -l`);
  assert.equal(insertShellTee("grep -r foo . | head", CAP), `grep -r foo . |${T} head`);
  assert.equal(insertShellTee("(cd a && make) | /usr/bin/tail -3", CAP), `(cd a && make) |${T} /usr/bin/tail -3`);
  assert.equal(insertShellTee("for f in *; do wc -c $f | sort; done", CAP), `for f in *; do wc -c $f |${T} sort; done`);
  assert.equal(insertShellTee("LC_ALL=C sort x | uniq -c | sort -rn | head", CAP), `LC_ALL=C sort x |${T} uniq -c | sort -rn | head`);
  assert.equal(insertShellTee("cat <<< 'a|b' | tail -1", CAP), `cat <<< 'a|b' |${T} tail -1`);
});

test("shell: leaves alone what it should not touch", () => {
  for (const command of [
    "npm test",
    "echo 'a | tail'",
    'echo "$(ls | head -1)"',
    "x=$(ls | wc -l); echo $x",
    "a || tail -1 b",
    "a |& tail",
    "echo `ls | head`",
    "cat <<EOF | tail -1\nhi\nEOF",
    "case $x in a) ls | head;; esac",
    "ls | xargs rm",
    "echo \"unterminated | tail",
    "diff <(sort a | head) b",
  ]) {
    assert.equal(insertShellTee(command, CAP), null, command);
  }
});

test("shell: a capture path with spaces is quoted", () => {
  assert.equal(shellTeeStage("/tmp/a b/c.log"), " { tee -a '/tmp/a b/c.log' || true; } |");
});

test("shell: rewritten commands keep output and status and capture the full stream", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
  const cap = path.join(dir, "c.log");
  /** @param {string} command */
  const run = (command) => {
    fs.writeFileSync(cap, "");
    const rewritten = insertShellTee(command, cap);
    assert.notEqual(rewritten, null, command);
    const original = spawnSync("bash", ["-c", `set -o pipefail; ${command}`], { encoding: "utf8" });
    const changed = spawnSync("bash", ["-c", `set -o pipefail; ${rewritten}`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(changed.stdout, original.stdout, command);
    assert.equal(changed.status, original.status, command);
    return fs.readFileSync(cap, "utf8");
  };
  try {
    assert.equal(run("seq 1 50 | tail -2"), [...Array(50).keys()].map((i) => `${i + 1}\n`).join(""));
    assert.equal(run("(seq 1 3; exit 4) | grep 2"), "1\n2\n3\n");
    // An early-closing filter still stops an endless producer.
    run("yes | head -3");
    run("seq 1 5 | head -1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("powershell: Tee-Object goes before the first filter", () => {
  assert.equal(powerShellTeeStage("C:\\Temp\\a.log"), " Tee-Object -FilePath C:\\Temp\\a.log -Append |");
  const P = powerShellTeeStage("C:\\Temp\\it's.log");
  assert.equal(P, " Tee-Object -FilePath 'C:\\Temp\\it''s.log' -Append |");
  assert.equal(
    insertPowerShellTee("npm test 2>&1 | Select-Object -Last 20", "C:\\Temp\\it's.log"),
    `npm test 2>&1 |${P} Select-Object -Last 20`,
  );
  assert.equal(
    insertPowerShellTee("Get-ChildItem -Recurse | ? { $_.Length -gt 1 } | select -First 3", "C:\\Temp\\it's.log"),
    `Get-ChildItem -Recurse |${P} ? { $_.Length -gt 1 } | select -First 3`,
  );
});

test("powershell: leaves alone what it should not touch", () => {
  for (const command of [
    "Get-Process",
    "$n = (Get-ChildItem | Measure-Object).Count",
    "Get-ChildItem | ForEach-Object { $_ | Select-Object -First 1 }",
    "@'\na | select\n'@ | Out-File x",
    "Write-Output \"$(Get-Date | select -First 1)\"",
    "Get-Content x | Out-File y",
  ]) {
    assert.equal(insertPowerShellTee(command, "C:\\x.log"), null, command);
  }
});

test("stripping restores the command the agent wrote", () => {
  for (const command of ["npm test | tail -20", "make | grep x; ls | wc -l"]) {
    assert.equal(stripCaptureStages(insertShellTee(command, CAP)), command);
    assert.equal(stripCaptureStages(insertShellTee(command, "/tmp/a b/c.log")), command);
  }
  const ps = "npm test | Select-Object -Last 5";
  assert.equal(stripCaptureStages(insertPowerShellTee(ps, "C:\\Temp\\it's.log")), ps);
  assert.equal(stripCaptureStages(insertPowerShellTee(ps, "C:\\Temp\\a.log")), ps);
});
