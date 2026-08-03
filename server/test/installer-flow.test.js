const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("installers install both harnesses without choices or login prompts", () => {
  const unix = read("install-server.sh");
  const windows = read("install.ps1");

  for (const [name, installer] of [
    ["install-server.sh", unix],
    ["install.ps1", windows],
  ]) {
    assert.match(installer, /@anthropic-ai\/claude-code@latest/);
    assert.match(installer, /@openai\/codex@latest/);
    assert.doesNotMatch(installer, /\bBackends?\b/);
    assert.doesNotMatch(installer, /Which managed agent toolchain/);
    assert.doesNotMatch(installer, /Claude Code Authentication/);
    assert.doesNotMatch(installer, /Codex Authentication/);
    assert.doesNotMatch(installer, /claude auth login/);
    assert.doesNotMatch(installer, /codex login --device-auth/);
    assert.doesNotMatch(installer, /Read-Host|prompt_read/);
    assert.match(installer, /Sign in later from the app or CLI if needed/);
    const pairingMarker = name === "install.ps1"
      ? "Show-QrCode $qrPayload"
      : "qrcode-terminal";
    assert.ok(
      installer.indexOf("Installation complete!") <
        installer.lastIndexOf(pairingMarker),
      `${name} should finish by presenting the pairing QR`,
    );
  }
});

test("public install entrypoints expose one-command setup only", () => {
  const unixEntrypoint = read("install.sh");
  const windowsEntrypoint = read("install-windows.ps1");
  const readme = read("README.md");

  assert.doesNotMatch(unixEntrypoint, /--backends?/);
  assert.doesNotMatch(windowsEntrypoint, /-Backends?/);
  assert.doesNotMatch(readme, /Choose Claude, Codex, or both/);
  assert.match(
    readme,
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Yllib\/socketagent\/master\/install\.sh \| bash/,
  );
  assert.match(
    readme,
    /irm https:\/\/raw\.githubusercontent\.com\/Yllib\/socketagent\/master\/install-windows\.ps1 \| iex/,
  );
});

test("Linux installs and repairs Codex's Bubblewrap sandbox dependency", () => {
  const installer = read("install-server.sh");
  const repair = read("server/scripts/ensure-codex-linux-sandbox.sh");
  const startup = read("server/src/index.ts");

  assert.match(installer, /ensure-codex-linux-sandbox\.sh/);
  assert.match(installer, /CODEX_SANDBOX_REPAIR" --interactive/);
  assert.match(repair, /apt-get install -y bubblewrap/);
  assert.match(repair, /dnf install -y bubblewrap/);
  assert.match(repair, /pacman -Sy --noconfirm bubblewrap/);
  assert.match(repair, /--unshare-all/);
  assert.match(repair, /bwrap-userns-restrict/);
  assert.match(repair, /sudo -n true/);
  assert.match(startup, /ensureCodexLinuxSandboxDependency\("startup"\)/);
  assert.match(startup, /periodic retry/);
  assert.match(startup, /SOCKETAGENT_AUTO_REPAIR_CODEX_SANDBOX/);
});
