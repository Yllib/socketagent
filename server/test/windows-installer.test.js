const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Windows installers never require the Microsoft Store package source", () => {
  for (const scriptName of ["install-windows.ps1", "install.ps1"]) {
    const script = read(scriptName);
    const installs = script
      .split(/\r?\n/)
      .filter((line) => /\bwinget\s+install\s+--id\b/i.test(line));

    assert.ok(installs.length > 0, `${scriptName} should install through WinGet`);
    for (const command of installs) {
      assert.match(command, /--source winget\b/i);
      assert.doesNotMatch(command, /--source msstore\b/i);
    }
  }
});

test("Windows installer verifies real executables and retains direct fallbacks", () => {
  const bootstrap = read("install-windows.ps1");
  const installer = read("install.ps1");

  assert.match(bootstrap, /Get-CommandWithoutStoreAlias/);
  assert.match(installer, /Get-CommandWithoutStoreAlias/);
  assert.match(installer, /Microsoft\\WindowsApps/);
  assert.match(installer, /github\.com\/git-for-windows\/git\/releases\/download/);
  assert.match(installer, /nodejs\.org\/dist\/v22\.14\.0/);
  assert.match(installer, /WinGet finished, but Node\.js .* is not runnable/);
});

test("Windows bootstrap stays in the current shell and generated commands reuse its host", () => {
  const bootstrap = read("install-windows.ps1");
  const installer = read("install.ps1");

  assert.match(bootstrap, /& \$installer/);
  assert.doesNotMatch(bootstrap, /&\s+powershell(?:\.exe)?\b/i);
  assert.doesNotMatch(bootstrap, /^\s*exit\b/im);
  assert.match(installer, /function Get-CurrentPowerShellExecutable/);
  assert.match(installer, /set "POWERSHELL_EXE=\$powerShellExe"/);
  assert.match(installer, /"%POWERSHELL_EXE%" -NoProfile/);
  assert.doesNotMatch(installer, /^\s*exit 1\s*$/im);
});

test("Windows forces npm lifecycle scripts through cmd.exe", () => {
  const installer = read("install.ps1");

  assert.match(installer, /function Set-NpmWindowsScriptShell/);
  assert.match(installer, /\$env:npm_config_script_shell = \$cmdPath/);
  assert.match(installer, /Ensure-NpmGlobalBinOnPath\s+Set-NpmWindowsScriptShell/);
  assert.match(installer, /set "npm_config_script_shell=%ComSpec%"/);
});
