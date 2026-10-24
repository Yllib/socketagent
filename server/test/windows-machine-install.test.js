const test = require("node:test");
const assert = require("node:assert/strict");
const { wrapperWithHandoff } = require("#server/windows-machine-service");
const { windowsMachineRoot } = require("#server/socket-agent-paths");
const { machineInstallMayRunBrowser } = require("#server/browser-session-manager");

const env = { ProgramData: "C:\\ProgramData", PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" };
const machineRoot = "C:\\ProgramData\\SocketAgent";
const newBat = "C:\\ProgramData\\SocketAgent\\socketagent\\server\\run-service.bat";
const oldBat = [
  "@echo off",
  ":loop",
  "call :arm_recovery",
  "goto loop",
  ":arm_recovery",
  "call :pin_profile",
  "exit /b 0",
  "",
].join("\r\n");

test("the old wrapper hands over to the moved install at its next start", () => {
  const moved = wrapperWithHandoff(oldBat, newBat);
  const lines = moved.split("\r\n");
  assert.equal(lines[lines.indexOf(":arm_recovery") + 1], `if exist "${newBat}" goto moved`);
  const tail = lines.slice(lines.indexOf(":moved"));
  // Chained without call, so the old loop never comes back.
  assert.equal(tail.at(-2), `"${newBat}"`);
  assert.equal(wrapperWithHandoff(moved, newBat), moved);
  assert.equal(wrapperWithHandoff("@echo off\r\n", newBat), undefined);
});

test("only the ProgramData checkout is a machine install", () => {
  assert.equal(windowsMachineRoot(env, "C:\\ProgramData\\SocketAgent\\socketagent", "win32"), machineRoot);
  assert.equal(windowsMachineRoot(env, "c:\\programdata\\socketagent\\SOCKETAGENT\\", "win32"), machineRoot);
  assert.equal(windowsMachineRoot(env, "C:\\Users\\lanik\\socketagent", "win32"), undefined);
  assert.equal(windowsMachineRoot(env, "C:\\ProgramData\\SocketAgent\\socketagent", "linux"), undefined);
});

test("a machine install runs only browsers that administrators installed", () => {
  assert.ok(machineInstallMayRunBrowser("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", machineRoot, env));
  assert.ok(machineInstallMayRunBrowser("C:\\ProgramData\\SocketAgent\\browser-runtime\\chrome\\chrome.exe", machineRoot, env));
  assert.ok(!machineInstallMayRunBrowser("C:\\Users\\lanik\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", machineRoot, env));
  // A sibling folder whose name starts the same is not inside Program Files.
  assert.ok(!machineInstallMayRunBrowser("C:\\Program Files Evil\\chrome.exe", machineRoot, env));
  assert.ok(!machineInstallMayRunBrowser("C:\\ProgramData\\SocketAgent\\browser-runtime-x\\chrome.exe", machineRoot, env));
});
