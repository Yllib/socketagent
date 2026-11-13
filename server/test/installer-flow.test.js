const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

/** @param {string} relativePath */
function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Unix entrypoint runs without a controlling terminal", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-installer-"));
  try {
    fs.copyFileSync(path.join(repoRoot, "install.sh"), path.join(fixture, "install.sh"));
    fs.mkdirSync(path.join(fixture, "server"));
    fs.writeFileSync(
      path.join(fixture, "install-server.sh"),
      "#!/usr/bin/env bash\nprintf 'delegated without tty\\n'\n",
      { mode: 0o755 },
    );
    const init = spawnSync("git", ["init", "--quiet", fixture], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const result = spawnSync("bash", [path.join(fixture, "install.sh")], {
      encoding: "utf8",
      input: "",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /delegated without tty/);
    assert.doesNotMatch(result.stderr, /\/dev\/tty/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("lingering is turned on through sudo when logind refuses the user", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-linger-"));
  try {
    const flag = path.join(fixture, "linger");
    // logind without polkit: only root may turn lingering on.
    fs.writeFileSync(
      path.join(fixture, "loginctl"),
      `#!/bin/bash
case "$1" in
  show-user) [ -e "${flag}" ] && echo yes || echo no ;;
  enable-linger) [ "$AS_ROOT" = 1 ] || { echo "Could not enable linger: Access denied" >&2; exit 1; }; touch "${flag}" ;;
esac
`,
      { mode: 0o755 },
    );
    /** @param {string} sudo */
    const run = (sudo) => {
      fs.writeFileSync(path.join(fixture, "sudo"), `#!/bin/bash\n${sudo}\n`, { mode: 0o755 });
      return spawnSync("bash", [path.join(repoRoot, "server/scripts/enable-linger.sh")], {
        encoding: "utf8",
        env: { PATH: `${fixture}:/usr/bin:/bin` },
      });
    };

    assert.equal(run("exit 1").status, 1, "a sudo that needs a password leaves lingering off");
    assert.equal(fs.existsSync(flag), false);
    assert.equal(run('[ "$1" = -n ] && shift; AS_ROOT=1 "$@"').status, 0);
    assert.equal(fs.existsSync(flag), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
