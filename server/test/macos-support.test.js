const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("server shell entrypoints pass bash syntax validation", () => {
  const scripts = [
    "install.sh",
    "install-server.sh",
    "bin/socketagent",
    "server/scripts/start-server.sh",
    "server/scripts/restart-server.sh",
    "server/scripts/recovery-guard.sh",
    "server/scripts/install-macos-helper.sh",
    "server/scripts/service-control.sh",
  ];
  const result = spawnSync("bash", ["-n", ...scripts], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("installer provides an Apple Silicon launchd service path", () => {
  const entrypoint = read("install.sh");
  const installer = read("install-server.sh");
  const serviceControl = read("server/scripts/service-control.sh");
  assert.match(entrypoint, /git --version/);
  assert.match(entrypoint, /xcode-select --install/);
  assert.match(installer, /Linux\|Darwin/);
  assert.match(installer, /node-v\$\{NODE_RUNTIME_VERSION\}-darwin-\$\{NODE_ARCH\}\.tar\.gz/);
  assert.match(installer, /Library\/LaunchAgents/);
  assert.match(installer, /SocketAgent Server\.app/);
  assert.match(installer, /com\.socketagent\.server/);
  assert.match(installer, /"\$SERVICE_CONTROL" start/);
  assert.match(serviceControl, /launchctl bootstrap/);
  assert.match(serviceControl, /for attempt in \$\(seq 1 10\)/);
  assert.match(installer, /<key>KeepAlive<\/key>/);
});

test("macOS helper has a stable app identity and privacy descriptions", () => {
  const helperInstaller = read("server/scripts/install-macos-helper.sh");
  const launcher = read("server/macos-helper/main.c");
  assert.match(helperInstaller, /com\.socketagent\.server\.helper/);
  assert.match(helperInstaller, /NSDocumentsFolderUsageDescription/);
  assert.match(helperInstaller, /codesign --force --deep --sign -/);
  assert.match(helperInstaller, /ProgramArguments:0/);
  assert.match(launcher, /SOCKETAGENT_START_SCRIPT/);
  assert.match(read("bin/socketagent"), /macos-permissions\|permissions/);
});

test("service lifecycle and recovery have explicit launchd implementations", () => {
  const serviceControl = read("server/scripts/service-control.sh");
  const recovery = read("server/scripts/recovery-guard.sh");
  const restart = read("server/scripts/restart-server.sh");

  for (const command of ["bootstrap", "bootout", "kickstart"]) {
    assert.match(serviceControl, new RegExp(`launchctl ${command}`));
  }
  assert.match(recovery, /launchctl submit/);
  assert.match(recovery, /wait-run/);
  assert.match(restart, /com\.socketagent\.restart/);
  assert.match(restart, /SERVICE_CONTROL.*restart/);
});

test("server-side managed Node repair distinguishes macOS from Linux", () => {
  const index = read("server/src/index.ts");
  assert.match(index, /process\.platform !== "linux" && process\.platform !== "darwin"/);
  assert.match(index, /process\.platform === "darwin" \? "darwin" : "linux"/);
  assert.match(index, /process\.platform === "darwin" \? "tar\.gz" : "tar\.xz"/);
  assert.match(index, /if \(process\.platform !== "linux"\) return;/);
  assert.match(index, /if \(remote === local\)/);
});
