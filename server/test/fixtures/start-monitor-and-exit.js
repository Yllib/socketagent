const { handleMonitorTool } = require("../../dist/app-tool-handlers");

(async () => {
  const result = await handleMonitorTool(
    {
      getSessionId: () => process.env.TEST_SESSION_ID,
      getCwd: () => process.cwd(),
      getBackend: () => "codex",
      send: () => {},
      appendHistory: () => {},
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      isRunning: () => true,
      injectMessage: async () => {},
    },
    {
      command: process.env.TEST_MONITOR_COMMAND || (process.platform === "win32"
        ? "echo before & ping -n 2 127.0.0.1 >nul & echo after"
        : "printf 'before\\n'; sleep 0.4; printf 'after\\n'; sleep 0.2"),
      description: "restart survival test",
    },
  );
  const taskId = /Task ID: ([A-Za-z0-9_-]+)/.exec(result.content[0].text)?.[1];
  const exitDelay = Number(process.env.TEST_PARENT_EXIT_DELAY_MS || 0);
  if (exitDelay > 0) await new Promise((resolve) => setTimeout(resolve, exitDelay));
  process.stdout.write(`${taskId}\n`);
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
