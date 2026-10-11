const { handleMonitorTool } = require("#server/app-tool-handlers");
const { getDurableMonitorRecord } = require("#server/durable-monitor-store");

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
  // Exit only after this parent has delivered output and checkpointed it, so
  // the restart test sees a known offset however slow the machine is.
  if (process.env.TEST_EXIT_AFTER_CHECKPOINT && taskId) {
    const deadline = Date.now() + 15_000;
    while (!(getDurableMonitorRecord(taskId)?.phoneOffset > 0)) {
      if (Date.now() > deadline) throw new Error("Monitor output was never checkpointed");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  process.stdout.write(`${taskId}\n`);
  process.exit(0);
})().catch((/** @type {unknown} */ error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
