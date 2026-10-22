const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  captureWindowsServiceConfig,
  parseWindowsServiceConfig,
  pinnedServiceEnvironment,
  windowsRunServiceBatContent,
  windowsServiceState,
} = require("#server/windows-service-config");

const env = { SystemRoot: "C:\\Windows" };
const owner = { user: "lanik", profile: "C:\\Users\\lanik" };
const system = { user: "SYSTEM", profile: "C:\\Windows\\system32\\config\\systemprofile" };
const config = {
  version: 1,
  owner: "lanik",
  profile: "C:\\Users\\lanik",
  appData: "C:\\Users\\lanik\\AppData\\Roaming",
  localAppData: "C:\\Users\\lanik\\AppData\\Local",
  codexHome: "C:\\Users\\lanik\\.codex",
};

// run-service.bat through `goto loop` as the server at 717dde4 wrote it. cmd
// resumes a running batch file by byte offset, so this part must never move.
const FROZEN_HEADER = [
  "@echo off",
  "setlocal EnableExtensions",
  "rem SocketAgent Windows service wrapper v2",
  'set "HOME=C:\\Users\\lanik"',
  'set "PATH=C:\\Windows\\system32;C:\\Program Files\\nodejs"',
  'set "SERVER_DIR=C:\\Users\\lanik\\socketagent\\server"',
  'set "REPO_ROOT=C:\\Users\\lanik\\socketagent"',
  'set "LOG_FILE=C:\\Users\\lanik\\socketagent\\server\\socketagent.log"',
  'set "POWERSHELL_EXE=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'set "NODE_EXE=C:\\Program Files\\nodejs\\node.exe"',
  'set "SERVER_SCRIPT=C:\\Users\\lanik\\socketagent\\server\\dist\\index.js"',
  'set "RECOVERY_BAT=C:\\Users\\lanik\\socketagent\\server\\run-recovery.bat"',
  'set "SOCKETAGENT_LAUNCHER=C:\\Users\\lanik\\AppData\\Local\\SocketAgent\\launchers\\socketagent-launcher-0123456789abcdef.exe"',
  'set "NPM_CMD=npm.cmd"',
  'set "NPX_CMD=npx.cmd"',
  'if exist "%ProgramFiles%\\nodejs\\npm.cmd" set "NPM_CMD=%ProgramFiles%\\nodejs\\npm.cmd"',
  'if exist "%ProgramFiles%\\nodejs\\npx.cmd" set "NPX_CMD=%ProgramFiles%\\nodejs\\npx.cmd"',
  "",
  'if "%SOCKETAGENT_SUPERVISED%"=="1" goto loop',
  '"%SOCKETAGENT_LAUNCHER%" --hide-parent-console "%~f0"',
  "exit /b %ERRORLEVEL%",
  "",
  ":loop",
  "call :arm_recovery",
  'call :preflight >> "%LOG_FILE%" 2>&1',
  'if errorlevel 1 echo [startup] Preflight update failed; launching existing build. >> "%LOG_FILE%" 2>&1',
  'cd /d "%SERVER_DIR%"',
  '"%NODE_EXE%" "%SERVER_SCRIPT%" >> "%LOG_FILE%" 2>&1',
  'echo Server exited (%ERRORLEVEL%), restarting in 5s... >> "%LOG_FILE%" 2>&1',
  '"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 5" >nul 2>&1',
  "goto loop",
  "",
].join("\r\n");

/** @param {Partial<typeof config> & { claudeConfigDir?: string }} [overrides] */
function wrapper(overrides = {}) {
  return windowsRunServiceBatContent({
    serverDir: "C:\\Users\\lanik\\socketagent\\server",
    repoRoot: "C:\\Users\\lanik\\socketagent",
    config: { ...config, ...overrides },
    path: "C:\\Windows\\system32;C:\\Program Files\\nodejs",
    powershellExe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    nodeExe: "C:\\Program Files\\nodejs\\node.exe",
    launcher: "C:\\Users\\lanik\\AppData\\Local\\SocketAgent\\launchers\\socketagent-launcher-0123456789abcdef.exe",
  });
}

test("run-service.bat keeps the 717dde4 header and loop byte for byte", () => {
  const content = wrapper();
  assert.equal(content.slice(0, FROZEN_HEADER.length), FROZEN_HEADER);
  assert.match(content.slice(FROZEN_HEADER.length), /^\r\n:arm_recovery\r\ncall :pin_profile\r\ncall :single_server\r\n/);
});

test("run-service.bat pins the owner's paths only under another account", () => {
  const content = wrapper();
  assert.ok(content.includes('if /I "%USERPROFILE%"=="C:\\Users\\lanik" exit /b 0'));
  assert.ok(content.includes('if not defined CODEX_HOME set "CODEX_HOME=C:\\Users\\lanik\\.codex"'));
  assert.ok(content.includes('set "GIT_CONFIG_VALUE_0=C:/Users/lanik/socketagent"'));
  assert.ok(!content.includes("CLAUDE_CONFIG_DIR"));
  assert.ok(wrapper({ claudeConfigDir: "D:\\claude" }).includes('if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=D:\\claude"'));
});

test("config parsing rejects bad JSON, bad fields and system profiles", () => {
  assert.equal(parseWindowsServiceConfig(JSON.stringify(config), env).status, "ok");
  assert.equal(parseWindowsServiceConfig("{", env).status, "invalid");
  assert.equal(parseWindowsServiceConfig(JSON.stringify({ ...config, profile: "lanik" }), env).status, "invalid");
  const pinnedToSystem = parseWindowsServiceConfig(JSON.stringify({ ...config, localAppData: "c:\\windows\\System32\\config\\systemprofile\\AppData\\Local" }), env);
  assert.equal(pinnedToSystem.status, "invalid");
  assert.match(pinnedToSystem.status === "invalid" ? pinnedToSystem.reason : "", /system profile/);
});

test("capture records the owner and refuses a system account", () => {
  const ownerEnv = { ...env, USERPROFILE: "C:\\Users\\lanik", APPDATA: config.appData, LOCALAPPDATA: config.localAppData };
  assert.deepEqual(captureWindowsServiceConfig(ownerEnv, owner), config);
  assert.equal(captureWindowsServiceConfig({ ...ownerEnv, CLAUDE_CONFIG_DIR: "D:\\claude" }, owner)?.claudeConfigDir, "D:\\claude");
  const systemEnv = { ...env, USERPROFILE: system.profile, LOCALAPPDATA: `${system.profile}\\AppData\\Local` };
  assert.equal(captureWindowsServiceConfig(systemEnv, system), undefined);
  // An owner's environment pinned into a SYSTEM process still names SYSTEM's own profile.
  assert.equal(captureWindowsServiceConfig(ownerEnv, system), undefined);
});

test("pins keep Codex, Claude and git settings the environment already has", () => {
  assert.deepEqual(pinnedServiceEnvironment(config, "C:\\Users\\lanik\\socketagent", {}), {
    HOME: "C:\\Users\\lanik",
    USERPROFILE: "C:\\Users\\lanik",
    APPDATA: config.appData,
    LOCALAPPDATA: config.localAppData,
    CODEX_HOME: config.codexHome,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "C:/Users/lanik/socketagent",
  });
  const kept = pinnedServiceEnvironment({ ...config, claudeConfigDir: "D:\\claude" }, "C:\\repo", { CODEX_HOME: "E:\\codex", GIT_CONFIG_COUNT: "2", CLAUDE_CONFIG_DIR: "F:\\claude" });
  assert.equal(kept.CODEX_HOME, undefined);
  assert.equal(kept.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(kept.GIT_CONFIG_COUNT, undefined);
  assert.equal(pinnedServiceEnvironment({ ...config, claudeConfigDir: "D:\\claude" }, "C:\\repo", {}).CLAUDE_CONFIG_DIR, "D:\\claude");
});

test("service state follows the account, not USERPROFILE", (t) => {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-service-state-"));
  t.after(() => fs.rmSync(serverDir, { recursive: true, force: true }));
  assert.equal(windowsServiceState(serverDir, env, owner).service, false);
  assert.equal(windowsServiceState(serverDir, env, system).service, true);
  fs.writeFileSync(path.join(serverDir, "windows-service.json"), JSON.stringify(config));
  assert.equal(windowsServiceState(serverDir, env, { ...owner, profile: "c:\\users\\LANIK\\" }).service, false);
  const asSystem = windowsServiceState(serverDir, env, system);
  assert.equal(asSystem.service, true);
  assert.deepEqual(asSystem.config, config);
  fs.writeFileSync(path.join(serverDir, "windows-service.json"), "{}");
  assert.ok(windowsServiceState(serverDir, env, owner).configProblem);
});

test("the single-server check passes only for a ready machine service", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sa-single-server-"));
  /** @type {Record<string, unknown>} */
  let body = {};
  const server = http.createServer((request, response) => {
    response.statusCode = request.headers.authorization === "Bearer lab-token" ? 200 : 401;
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => {
    server.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.symlinkSync(path.resolve(__dirname, "../node_modules"), path.join(fixture, "node_modules"), "junction");
  fs.copyFileSync(path.resolve(__dirname, "../scripts/check-machine-service.js"), path.join(fixture, "scripts/check-machine-service.js"));
  fs.writeFileSync(path.join(fixture, ".env"), `PORT=${address.port}\nAUTH_TOKEN=lab-token\n`);
  /** @returns {Promise<number | null>} */
  const check = () => new Promise((resolve) => {
    spawn(process.execPath, [path.join(fixture, "scripts/check-machine-service.js")]).on("exit", resolve);
  });
  const ready = { service: "socketagent", ready: true };
  body = { ...ready, identity: { service: true } };
  assert.equal(await check(), 0);
  body = { ...ready, identity: { service: false } };
  assert.equal(await check(), 1);
  body = { ...ready, ready: false, identity: { service: true } };
  assert.equal(await check(), 1);
  body = ready;
  assert.equal(await check(), 1);
});
