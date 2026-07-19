const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleMonitorTool,
  stopAppMonitorsForSession,
} = require("../dist/app-tool-handlers");

test("hard stop terminates detached Monitor process trees owned by the session", async () => {
  if (process.platform === "win32") return;
  const sessionId = `monitor-stop-${Date.now()}`;
  const result = await handleMonitorTool(
    {
      getSessionId: () => sessionId,
      getCwd: () => process.cwd(),
      send: () => {},
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      injectMessage: async () => {},
    },
    { command: "sleep 30", description: "hard-stop test" },
  );
  const text = result.content[0].text;
  const pid = Number(/PID: (\d+)/.exec(text)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, text);

  assert.equal(await stopAppMonitorsForSession("another-session"), 0);
  assert.equal(await stopAppMonitorsForSession(sessionId), 1);
  assert.throws(() => process.kill(pid, 0));
});
