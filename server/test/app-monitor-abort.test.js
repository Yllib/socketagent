const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const monitorDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-monitor-test-"));
process.env.SOCKETAGENT_DATA_DIR = monitorDataDir;
process.env.SOCKETAGENT_MONITOR_LAUNCH_MODE = "direct";

test.after(() => fs.rmSync(monitorDataDir, { recursive: true, force: true }));

const {
  handleMonitorTool,
  rebindAppMonitorsForSession,
  stopAppMonitor,
  stopAppMonitorsForSession,
} = require("../dist/app-tool-handlers");

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const result = predicate();
      if (result) return resolve(result);
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error("Timed out waiting for monitor event"));
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

test("Monitor streams output, persists it, and emits a terminal lifecycle", async () => {
  if (process.platform === "win32") return;
  const sessionId = `monitor-lifecycle-${Date.now()}`;
  const sent = [];
  const history = [];
  await handleMonitorTool(
    {
      getSessionId: () => sessionId,
      getCwd: () => process.cwd(),
      send: (message) => sent.push(message),
      appendHistory: (entry) => history.push(entry),
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      isRunning: () => true,
      injectMessage: async () => {},
    },
    {
      command: "printf 'first\\n'; sleep 0.05; printf 'last\\n'",
      description: "lifecycle test",
    },
  );

  await waitFor(() => sent.find((message) => message.type === "task_notification"));
  const output = sent
    .filter((message) => message.type === "monitor_output")
    .map((message) => message.content)
    .join("\n");
  assert.match(output, /first/);
  assert.match(output, /last/);
  assert.match(output, /Process exited with code 0/);
  const persisted = history.at(-1)?.content || "";
  assert.match(persisted, /first/);
  assert.match(persisted, /last/);
  assert.match(persisted, /Process exited with code 0/);
  assert.ok(sent.some((message) =>
    message.type === "monitor_started" && message.monitoring === false,
  ));
});

test("disabling Monitor clears the phone lifecycle without killing the process", async () => {
  if (process.platform === "win32") return;
  const sessionId = `monitor-disable-${Date.now()}`;
  const sent = [];
  const result = await handleMonitorTool(
    {
      getSessionId: () => sessionId,
      getCwd: () => process.cwd(),
      send: (message) => sent.push(message),
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      injectMessage: async () => {},
    },
    { command: "sleep 0.2", description: "disable test" },
  );
  const taskId = /Task ID: ([A-Za-z0-9_-]+)/.exec(result.content[0].text)?.[1];
  assert.ok(taskId);
  assert.equal(stopAppMonitor(taskId, true, false), true);
  assert.ok(sent.some((message) =>
    message.type === "monitor_started" &&
    message.taskId === taskId &&
    message.monitoring === false,
  ));
});

test("a persistent Monitor rebinds away from a completed Claude turn", async () => {
  if (process.platform === "win32") return;
  const sessionId = `monitor-rebind-${Date.now()}`;
  const original = [];
  const durable = [];
  const result = await handleMonitorTool(
    {
      getSessionId: () => sessionId,
      getCwd: () => process.cwd(),
      getBackend: () => "claude",
      send: (message) => original.push(message),
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      isRunning: () => false,
      onMonitorOutput: () => {
        throw new Error("completed turn context should not receive output");
      },
    },
    {
      command: "sleep 0.2; printf 'after-turn\\n'; sleep 0.1",
      description: "persistent Claude monitor",
    },
  );
  const taskId = /Task ID: ([A-Za-z0-9_-]+)/.exec(result.content[0].text)?.[1];
  assert.ok(taskId);

  assert.equal(
    rebindAppMonitorsForSession(sessionId, (record) => ({
      getSessionId: () => record.sessionId,
      getCwd: () => record.cwd,
      getBackend: () => record.backend,
      send: (message) => durable.push(message),
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      isRunning: () => false,
      onMonitorOutput: (text) => durable.push({ type: "agent_output", text }),
    })),
    1,
  );

  await waitFor(
    () => durable.find((message) => message.type === "task_notification"),
    5_000,
  );
  assert.ok(
    durable.some(
      (message) =>
        message.type === "agent_output" && /after-turn/.test(message.text),
    ),
  );
  assert.equal(
    original.some((message) => message.type === "task_notification"),
    false,
  );
});

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

test("terminal output waits behind an in-flight agent delivery without loss or duplication", async () => {
  if (process.platform === "win32") return;
  const sessionId = `monitor-overlap-${Date.now()}`;
  const sent = [];
  const injected = [];
  await handleMonitorTool(
    {
      getSessionId: () => sessionId,
      getCwd: () => process.cwd(),
      send: (message) => sent.push(message),
      getTtsEngine: () => "system",
      getKokoroVoice: () => "",
      getKokoroSpeed: () => 1,
      isRunning: () => true,
      injectMessage: async (text) => {
        injected.push(text);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      },
    },
    {
      // The initial output starts the 5s debounce delivery. The command exits
      // while that delivery is still awaiting the agent.
      command: "printf 'first\\n'; sleep 5.6; printf 'last\\n'",
      description: "overlapping terminal flush",
    },
  );

  await waitFor(
    () => sent.find((message) => message.type === "task_notification"),
    10_000,
  );
  const delivered = injected.join("\n");
  assert.equal((delivered.match(/first/g) || []).length, 1);
  assert.equal((delivered.match(/last/g) || []).length, 1);
  assert.match(delivered, /Process exited with code 0/);
});
