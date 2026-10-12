const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
require("./test-data-dir");

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-config-"));
process.env.CODEX_HOME = codexHome;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
test.after(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

const {
  backendConfigFileIdForPath,
  listBackendConfigFiles,
  readBackendConfigFile,
  writeBackendConfigFile,
} = require("#server/backend-config-files");
const { getComputerIssues, recordCodexConfigWarning } = require("#server/server-settings");

test("the list is the fixed allowlist under CODEX_HOME and CLAUDE_CONFIG_DIR, never credentials", () => {
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":{}}');
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), '{"claudeAiOauth":{}}');
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');

  const files = listBackendConfigFiles();
  assert.deepEqual(
    files.map((file) => [file.id, file.path, file.exists]),
    [
      ["codex-config", path.join(codexHome, "config.toml"), true],
      ["codex-agents", path.join(codexHome, "AGENTS.md"), false],
      ["claude-settings", path.join(claudeDir, "settings.json"), false],
      ["claude-md", path.join(claudeDir, "CLAUDE.md"), false],
    ],
  );
  assert.ok(files.every((file) => !/auth|credential/i.test(file.path)));
  assert.throws(() => readBackendConfigFile("auth.json"), /Unknown config file/);
  assert.throws(() => readBackendConfigFile(path.join(codexHome, "auth.json")), /Unknown config file/);
  assert.throws(() => writeBackendConfigFile("../auth.json", "{}", null), /Unknown config file/);
  assert.equal(backendConfigFileIdForPath(path.join(codexHome, "config.toml")), "codex-config");
  assert.equal(backendConfigFileIdForPath(path.join(codexHome, "auth.json")), undefined);
});

test("a save needs the version the editor loaded, and a bad save never reaches the file", () => {
  const settingsPath = path.join(claudeDir, "settings.json");
  const missing = readBackendConfigFile("claude-settings");
  assert.equal(missing.file.exists, false);
  assert.equal(missing.file.version, undefined);
  assert.equal(missing.content, "");

  const created = writeBackendConfigFile("claude-settings", '{"model":"opus"}', null);
  assert.ok(created.ok);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"model":"opus"}');
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);

  // Someone else saved in between: the phone's version is stale.
  fs.writeFileSync(settingsPath, '{"model":"sonnet"}');
  const stale = writeBackendConfigFile("claude-settings", '{"model":"haiku"}', created.file.version);
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.current.content, '{"model":"sonnet"}');
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"model":"sonnet"}');

  const fresh = writeBackendConfigFile("claude-settings", '{"model":"haiku"}', stale.current.file.version);
  assert.ok(fresh.ok);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"model":"haiku"}');

  assert.throws(() => writeBackendConfigFile("claude-settings", "{", fresh.file.version), /not valid JSON/);
  assert.throws(() => writeBackendConfigFile("claude-settings", "[]", fresh.file.version), /JSON object/);
  assert.throws(
    () => writeBackendConfigFile("codex-config", 'model = "gpt-5"\nsandbox = \n', null),
    /not valid TOML\. Line 2, column 11\. invalid value/,
  );
  assert.throws(() => writeBackendConfigFile("claude-md", 42, null), /Content must be text/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{"model":"haiku"}');
  assert.deepEqual(fs.readdirSync(claudeDir).filter((name) => name.includes("socketagent")), []);
});

test("saving config.toml clears the Codex warning that pointed at it", () => {
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, "windows_wsl_setup_acknowledged = true\n");
  fs.utimesSync(configPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const message = "`windows_wsl_setup_acknowledged` is ignored.";
  recordCodexConfigWarning(message, configPath);

  const issue = getComputerIssues().find((candidate) => candidate.message === message);
  assert.equal(issue?.configFile, "codex-config");

  const loaded = readBackendConfigFile("codex-config");
  const saved = writeBackendConfigFile("codex-config", 'model = "gpt-5"\n', loaded.file.version);
  assert.ok(saved.ok);
  assert.ok(!getComputerIssues().some((candidate) => candidate.message === message));
});

test("saving a symlinked config writes its target and keeps the link", { skip: process.platform === "win32" && "Symlinks need privileges on Windows" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-link-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(home, ".codex");
  try {
    fs.mkdirSync(process.env.CODEX_HOME);
    const real = path.join(home, "dotfiles-config.toml");
    fs.writeFileSync(real, "model = \"a\"\n");
    fs.symlinkSync(real, path.join(process.env.CODEX_HOME, "config.toml"));
    const { file } = readBackendConfigFile("codex-config");
    const saved = writeBackendConfigFile("codex-config", "model = \"b\"\n", file.version ?? null);
    assert.equal(saved.ok, true);
    assert.ok(fs.lstatSync(path.join(process.env.CODEX_HOME, "config.toml")).isSymbolicLink());
    assert.equal(fs.readFileSync(real, "utf8"), "model = \"b\"\n");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
